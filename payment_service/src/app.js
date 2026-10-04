const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('./config/env');
const { connectDB } = require('./config/db');
const { connectRabbitMQ, closeRabbitMQ } = require('./config/rabbitmq');
const paymentRoutes = require('./routes/paymentRoutes');
const errorHandler = require('./middleware/errorHandler');
const MessageQueueService = require('./services/messageQueue');
const Payment = require('./models/Payment');
const PaymentProcessor = require('./services/paymentProcessor');

const app = express();

// ─── Security Middleware ────────────────────────────────────────
app.use(helmet()); // Set security HTTP headers
app.use(cors());   // Enable CORS for all origins (configure in production)

// ─── Rate Limiting ──────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.includes('/health'), // Exclude Kubernetes health probes
});
app.use('/api/', limiter);

// ─── Body Parsing ───────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));       // Limit body size
app.use(express.urlencoded({ extended: true }));

// ─── Logging ────────────────────────────────────────────────────
if (config.nodeEnv === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// ─── Routes ─────────────────────────────────────────────────────
app.use('/api/payments', paymentRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Payment Service',
    version: '1.0.0',
    description: 'Payment microservice for Event Ticket Booking Platform',
    endpoints: {
      health: 'GET /api/payments/health',
      createPayment: 'POST /api/payments',
      getPayment: 'GET /api/payments/:id',
      getByBooking: 'GET /api/payments/booking/:bookingId',
      myPayments: 'GET /api/payments/user/me',
      refund: 'POST /api/payments/:id/refund',
    },
  });
});

// ─── 404 Handler ────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`,
  });
});

// ─── Global Error Handler ───────────────────────────────────────
app.use(errorHandler);

// ─── Message Queue Consumer Handler ─────────────────────────────
const handlePaymentRequest = async (message, messageMetadata = {}) => {
  const data = message.data || message;
  const requestKey = messageMetadata.messageId
    ? `message:${messageMetadata.messageId}`
    : `booking:${data.bookingId}`;

  console.log(`📥 Processing payment request from MQ:`, data);

  // RabbitMQ provides at-least-once delivery, so persist a stable request key.
  // Booking Service currently omits an AMQP message ID; bookingId is its stable fallback.
  const [payment, created] = await Payment.findOrCreate({
    where: { requestKey },
    defaults: {
      bookingId: data.bookingId,
      userId: data.userId,
      requestKey,
      amount: data.amount,
      currency: data.currency || 'USD',
      paymentMethod: data.paymentMethod || 'credit_card',
      cardLast4: data.cardLast4 || null,
      status: 'processing',
      metadata: data.metadata || {},
    },
  });

  if (!created) {
    console.log(`♻️ Duplicate payment request ${requestKey}; reusing payment ${payment.id}`);
    if (payment.status === 'completed') {
      await MessageQueueService.publishPaymentCompleted(payment);
    } else if (payment.status === 'failed') {
      await MessageQueueService.publishPaymentFailed(payment, payment.failureReason);
    }
    return payment;
  }

  // Process through payment gateway
  const result = await PaymentProcessor.processPayment({
    amount: payment.amount,
    currency: payment.currency,
    paymentMethod: payment.paymentMethod,
    cardLast4: payment.cardLast4,
  });

  if (result.success) {
    await payment.update({
      status: 'completed',
      transactionId: result.transactionId,
    });
    await MessageQueueService.publishPaymentCompleted(payment);
  } else {
    await payment.update({
      status: 'failed',
      failureReason: result.error,
    });
    await MessageQueueService.publishPaymentFailed(payment, result.error);
  }

  return payment;
};

// ─── Start Server ───────────────────────────────────────────────
const startServer = async () => {
  try {
    // 1. Connect to PostgreSQL
    await connectDB();

    // 2. Connect to RabbitMQ
    await connectRabbitMQ();

    // 3. Start consuming payment requests from MQ
    try {
      await MessageQueueService.consumePaymentRequests(handlePaymentRequest);
    } catch (mqErr) {
      console.warn('⚠️ MQ consumer not started (RabbitMQ may be unavailable):', mqErr.message);
    }

    // 4. Start Express server
    const server = app.listen(config.port, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║          💳 PAYMENT SERVICE STARTED             ║');
      console.log('╠══════════════════════════════════════════════════╣');
      console.log(`║  Port:        ${config.port}                            ║`);
      console.log(`║  Environment: ${config.nodeEnv.padEnd(20)}         ║`);
      console.log(`║  Database:    PostgreSQL                        ║`);
      console.log(`║  Message MQ:  RabbitMQ                          ║`);
      console.log('╠══════════════════════════════════════════════════╣');
      console.log('║  API Docs:    http://localhost:' + config.port + '              ║');
      console.log('║  Health:      http://localhost:' + config.port + '/api/payments/health ║');
      console.log('╚══════════════════════════════════════════════════╝');
      console.log('');
    });

    // ─── Graceful Shutdown ──────────────────────────────────────
    const gracefulShutdown = async (signal) => {
      console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
      
      server.close(async () => {
        console.log('✅ HTTP server closed');
        await closeRabbitMQ();
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        console.error('❌ Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

module.exports = app;
module.exports.startServer = startServer;
module.exports.handlePaymentRequest = handlePaymentRequest;
