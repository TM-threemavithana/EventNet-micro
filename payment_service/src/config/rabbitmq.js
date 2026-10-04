const amqplib = require('amqplib');
const config = require('./env');

let connection = null;
let channel = null;
let closing = false;

/**
 * Connect to RabbitMQ with automatic reconnection
 */
const connectRabbitMQ = async () => {
  try {
    closing = false;
    connection = await amqplib.connect(config.rabbitmq.url);
    channel = await connection.createChannel();

    // Assert the exchange
    await channel.assertExchange(
      config.rabbitmq.exchange,
      config.rabbitmq.exchangeType,
      { durable: true }
    );

    // Assert all queues
    const queues = config.rabbitmq.queues;
    for (const [key, queueName] of Object.entries(queues)) {
      await channel.assertQueue(queueName, {
        durable: true,
      });

      // Bind queue to exchange with routing key
      await channel.bindQueue(queueName, config.rabbitmq.exchange, queueName);
    }

    // Prefetch 1 message at a time for fair dispatch
    await channel.prefetch(1);

    console.log('✅ RabbitMQ connected successfully');
    console.log(`   Exchange: ${config.rabbitmq.exchange}`);
    console.log(`   Queues: ${Object.values(queues).join(', ')}`);

    // Handle connection close - reconnect
    connection.on('close', () => {
      channel = null;
      connection = null;
      if (!closing) {
        console.error('❌ RabbitMQ connection closed. Reconnecting...');
        setTimeout(connectRabbitMQ, 5000);
      }
    });

    connection.on('error', (err) => {
      console.error('❌ RabbitMQ connection error:', err.message);
    });

    return channel;
  } catch (error) {
    console.error('❌ RabbitMQ connection failed:', error.message);
    console.log('🔄 Retrying RabbitMQ connection in 5 seconds...');
    setTimeout(connectRabbitMQ, 5000);
    return null;
  }
};

/**
 * Get the current RabbitMQ channel
 */
const getChannel = () => {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }
  return channel;
};

/**
 * Close RabbitMQ connection gracefully
 */
const closeRabbitMQ = async () => {
  try {
    closing = true;
    if (channel) await channel.close();
    if (connection) await connection.close();
    channel = null;
    connection = null;
    console.log('✅ RabbitMQ connection closed gracefully');
  } catch (error) {
    console.error('❌ Error closing RabbitMQ:', error.message);
  }
};

module.exports = { connectRabbitMQ, getChannel, closeRabbitMQ };
