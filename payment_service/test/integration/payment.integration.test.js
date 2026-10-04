process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5433';
process.env.DB_NAME = process.env.DB_NAME || 'payment_service_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5673';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-secret';
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';

const request = require('supertest');
const jwt = require('jsonwebtoken');

const app = require('../../src/app');
const { handlePaymentRequest } = app;
const { sequelize } = require('../../src/config/db');
const { connectRabbitMQ, getChannel, closeRabbitMQ } = require('../../src/config/rabbitmq');
const config = require('../../src/config/env');
const Payment = require('../../src/models/Payment');
const PaymentProcessor = require('../../src/services/paymentProcessor');
const MessageQueueService = require('../../src/services/messageQueue');

const tokenFor = (id, role = 'user') => jwt.sign(
  { id, email: `${id}@example.test`, role },
  config.jwt.secret,
  { expiresIn: '5m' }
);

const waitFor = async (check, description, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const nextMessage = async (queue) => waitFor(async () => {
  const channel = getChannel();
  const message = await channel.get(queue, { noAck: false });
  if (!message) return null;
  channel.ack(message);
  return JSON.parse(message.content.toString());
}, `a message on ${queue}`);

describe('payment service integration', () => {
  beforeAll(async () => {
    jest.spyOn(PaymentProcessor, '_simulateDelay').mockResolvedValue();
    await sequelize.authenticate();
    await sequelize.sync({ force: true });
    await connectRabbitMQ();

    const channel = getChannel();
    for (const queue of new Set(Object.values(config.rabbitmq.queues))) {
      await channel.purgeQueue(queue);
    }
  });

  afterAll(async () => {
    await closeRabbitMQ();
    await sequelize.close();
    jest.restoreAllMocks();
  });

  test('authenticated payment and refund enforce ownership and publish lifecycle events', async () => {
    const ownerToken = tokenFor('user-1');
    const otherToken = tokenFor('user-2');

    await request(app)
      .post('/api/payments')
      .send({ bookingId: 1001, amount: 49.99, paymentMethod: 'credit_card', cardLast4: '4242' })
      .expect(401);

    const created = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bookingId: 1001, amount: 49.99, currency: 'USD', paymentMethod: 'credit_card', cardLast4: '4242' })
      .expect(201);

    expect(created.body.data).toMatchObject({ bookingId: 1001, status: 'completed', currency: 'USD' });
    expect(created.body.data.transactionId).toMatch(/^txn_/);

    const completedEvent = await nextMessage(config.rabbitmq.queues.paymentCompleted);
    expect(completedEvent).toMatchObject({
      eventType: 'PAYMENT_SUCCESS',
      bookingId: 1001,
      paymentId: created.body.data.id,
      status: 'completed',
      service: 'payment-service',
    });
    expect(completedEvent.messageId).toEqual(expect.any(String));

    await request(app)
      .get(`/api/payments/${created.body.data.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);

    await request(app)
      .get(`/api/payments/${created.body.data.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const refunded = await request(app)
      .post(`/api/payments/${created.body.data.id}/refund`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(refunded.body.data.status).toBe('refunded');
    const refundedEvent = await nextMessage(config.rabbitmq.queues.paymentRefunded);
    expect(refundedEvent).toMatchObject({
      event: 'PAYMENT_REFUNDED',
      data: { paymentId: created.body.data.id, bookingId: 1001, status: 'refunded' },
      service: 'payment-service',
    });

    await request(app)
      .post(`/api/payments/${created.body.data.id}/refund`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
  });

  test('RabbitMQ requeues a transient failure and a later duplicate does not recharge', async () => {
    let attempts = 0;
    let brokerMarkedRedelivery = false;
    await MessageQueueService.consumePaymentRequests(async (message, metadata) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('simulated transient database failure');
      }
      brokerMarkedRedelivery ||= metadata.redelivered;
      return handlePaymentRequest(message, metadata);
    });
    const channel = getChannel();
    const paymentRequest = {
      eventType: 'PAYMENT_REQUESTED',
      bookingId: 2002,
      userId: 'queue-user',
      amount: 75.5,
      currency: 'LKR',
      paymentMethod: 'credit_card',
      cardLast4: '4242',
    };

    const publishRequest = () => channel.sendToQueue(
      config.rabbitmq.queues.paymentRequest,
      Buffer.from(JSON.stringify(paymentRequest)),
      { persistent: true, contentType: 'application/json' }
    );

    publishRequest();
    const firstEvent = await nextMessage(config.rabbitmq.queues.paymentCompleted);
    expect(attempts).toBe(2);
    expect(brokerMarkedRedelivery).toBe(true);

    publishRequest();
    const redeliveredEvent = await nextMessage(config.rabbitmq.queues.paymentCompleted);

    const payments = await Payment.findAll({ where: { bookingId: 2002 } });
    expect(payments).toHaveLength(1);
    expect(payments[0].get()).toMatchObject({ status: 'completed', requestKey: 'booking:2002' });
    expect(redeliveredEvent.paymentId).toBe(firstEvent.paymentId);
    expect(redeliveredEvent.bookingId).toBe(firstEvent.bookingId);
  });

  test('a declined authenticated payment is persisted and published as a failure', async () => {
    const response = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokenFor('declined-user')}`)
      .send({ bookingId: 3003, amount: 15, currency: 'USD', paymentMethod: 'debit_card', cardLast4: '0000' })
      .expect(400);

    expect(response.body).toMatchObject({
      success: false,
      message: 'Payment failed',
      data: { bookingId: 3003, status: 'failed' },
    });
    const failedEvent = await nextMessage(config.rabbitmq.queues.paymentFailed);
    expect(failedEvent).toMatchObject({
      eventType: 'PAYMENT_FAILED',
      bookingId: 3003,
      paymentId: response.body.data.id,
      status: 'failed',
      reason: 'Card declined: Insufficient funds',
    });
  });
});
