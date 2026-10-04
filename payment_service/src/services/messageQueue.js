const { getChannel } = require('../config/rabbitmq');
const config = require('../config/env');

/**
 * Message Queue Service
 * Handles publishing and consuming messages via RabbitMQ
 * for async communication between microservices.
 */
class MessageQueueService {
  /**
   * Publish a message to a specific routing key
   * @param {string} routingKey - The routing key (queue name)
   * @param {Object} message - The message payload
   */
  static async publish(routingKey, message) {
    try {
      const channel = getChannel();
      const messageBuffer = Buffer.from(
        JSON.stringify({
          ...message,
          timestamp: new Date().toISOString(),
          service: 'payment-service',
        })
      );

      channel.publish(config.rabbitmq.exchange, routingKey, messageBuffer, {
        persistent: true, // Survive broker restart
        contentType: 'application/json',
        messageId: require('uuid').v4(),
      });

      console.log(`📤 Published to [${routingKey}]:`, JSON.stringify(message).substring(0, 100));
    } catch (error) {
      console.error(`❌ Failed to publish to [${routingKey}]:`, error.message);
      throw error;
    }
  }

  /**
   * Publish payment completed event
   */
  static async publishPaymentCompleted(paymentData) {
  await this.publish(config.rabbitmq.queues.paymentCompleted, {
    messageId: require('uuid').v4(),
    eventType: 'PAYMENT_SUCCESS',        // ← booking service expects this
    bookingId: paymentData.bookingId,
    paymentId: paymentData.id,
    status: 'completed',
    amount: paymentData.amount,
  });
}

  /**
   * Publish payment failed event
   */
  static async publishPaymentFailed(paymentData, reason) {
  await this.publish(config.rabbitmq.queues.paymentFailed, {
    messageId: require('uuid').v4(),
    eventType: 'PAYMENT_FAILED',         // ← booking service expects this
    bookingId: paymentData.bookingId,
    paymentId: paymentData.id,
    status: 'failed',
    reason: reason,
  });
}

  /**
   * Publish payment refunded event
   */
  static async publishPaymentRefunded(paymentData) {
    await this.publish(config.rabbitmq.queues.paymentRefunded, {
      event: 'PAYMENT_REFUNDED',
      data: {
        paymentId: paymentData.id,
        bookingId: paymentData.bookingId,
        userId: paymentData.userId,
        amount: paymentData.amount,
        transactionId: paymentData.transactionId,
        status: 'refunded',
      },
    });
  }

  /**
   * Start consuming payment request messages from Booking Service
   * @param {Function} handler - Callback to process each message
   */
  static async consumePaymentRequests(handler) {
    try {
      const channel = getChannel();
      const queue = config.rabbitmq.queues.paymentRequest;

      console.log(`👂 Listening for messages on [${queue}]...`);

      channel.consume(
        queue,
        async (msg) => {
          if (msg) {
            try {
              const content = JSON.parse(msg.content.toString());
              console.log(`📥 Received from [${queue}]:`, JSON.stringify(content).substring(0, 100));

              await handler(content, {
                messageId: msg.properties.messageId,
                redelivered: msg.fields.redelivered,
              });

              // Acknowledge the message
              channel.ack(msg);
            } catch (error) {
              console.error('❌ Error processing message:', error.message);
              // Reject and requeue the message
              channel.nack(msg, false, true);
            }
          }
        },
        { noAck: false }
      );
    } catch (error) {
      console.error('❌ Failed to start consumer:', error.message);
      throw error;
    }
  }
}

module.exports = MessageQueueService;
