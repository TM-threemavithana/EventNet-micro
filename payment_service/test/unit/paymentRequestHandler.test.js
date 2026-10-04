process.env.NODE_ENV = 'test';

jest.mock('../../src/models/Payment', () => ({
  findOrCreate: jest.fn(),
}));
jest.mock('../../src/services/paymentProcessor', () => ({
  processPayment: jest.fn(),
}));
jest.mock('../../src/services/messageQueue', () => ({
  publishPaymentCompleted: jest.fn(),
  publishPaymentFailed: jest.fn(),
  consumePaymentRequests: jest.fn(),
}));

const Payment = require('../../src/models/Payment');
const PaymentProcessor = require('../../src/services/paymentProcessor');
const MessageQueueService = require('../../src/services/messageQueue');
const { handlePaymentRequest } = require('../../src/app');

const request = {
  bookingId: 42,
  userId: 'user-42',
  amount: 10,
  currency: 'USD',
  paymentMethod: 'credit_card',
  cardLast4: '4242',
};

describe('payment request idempotency', () => {
  beforeEach(() => jest.clearAllMocks());

  test('charges and publishes a newly created request once', async () => {
    const payment = {
      id: 'payment-1',
      amount: '10.00',
      currency: 'USD',
      paymentMethod: 'credit_card',
      cardLast4: '4242',
      status: 'processing',
      update: jest.fn(async (values) => Object.assign(payment, values)),
    };
    Payment.findOrCreate.mockResolvedValue([payment, true]);
    PaymentProcessor.processPayment.mockResolvedValue({ success: true, transactionId: 'txn_1' });

    await handlePaymentRequest(request, { messageId: 'request-1' });

    expect(Payment.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      where: { requestKey: 'message:request-1' },
    }));
    expect(PaymentProcessor.processPayment).toHaveBeenCalledTimes(1);
    expect(payment.update).toHaveBeenCalledWith({ status: 'completed', transactionId: 'txn_1' });
    expect(MessageQueueService.publishPaymentCompleted).toHaveBeenCalledWith(payment);
  });

  test('does not recharge a duplicate and re-emits its completed result', async () => {
    const payment = { id: 'payment-1', status: 'completed' };
    Payment.findOrCreate.mockResolvedValue([payment, false]);

    await handlePaymentRequest(request, { redelivered: true });

    expect(Payment.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      where: { requestKey: 'booking:42' },
    }));
    expect(PaymentProcessor.processPayment).not.toHaveBeenCalled();
    expect(MessageQueueService.publishPaymentCompleted).toHaveBeenCalledWith(payment);
  });

  test('propagates processing errors so the consumer can nack and requeue', async () => {
    Payment.findOrCreate.mockRejectedValue(new Error('database unavailable'));

    await expect(handlePaymentRequest(request)).rejects.toThrow('database unavailable');
    expect(MessageQueueService.publishPaymentCompleted).not.toHaveBeenCalled();
  });
});
