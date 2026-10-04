const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Payment = sequelize.define(
  'Payment',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    bookingId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'booking_id',
      comment: 'Reference to the booking in Booking Service',
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'user_id',
      comment: 'Reference to the user in User Service',
    },
    requestKey: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'request_key',
      comment: 'Stable idempotency key for queue-originated payment requests',
    },
    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      validate: {
        min: 0.01,
      },
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'USD',
      validate: {
        isIn: [['USD', 'EUR', 'GBP', 'LKR']],
      },
    },
    status: {
      type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed', 'refunded'),
      allowNull: false,
      defaultValue: 'pending',
    },
    paymentMethod: {
      type: DataTypes.ENUM('credit_card', 'debit_card', 'bank_transfer', 'digital_wallet'),
      allowNull: false,
      field: 'payment_method',
    },
    transactionId: {
      type: DataTypes.STRING,
      unique: true,
      field: 'transaction_id',
      comment: 'External payment gateway transaction ID',
    },
    cardLast4: {
      type: DataTypes.STRING(4),
      allowNull: true,
      field: 'card_last4',
      comment: 'Last 4 digits of card (for display only)',
    },
    failureReason: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'failure_reason',
    },
    refundedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'refunded_at',
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      comment: 'Additional payment metadata (event name, ticket details, etc.)',
    },
  },
  {
    tableName: 'payments',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['booking_id'] },
      { fields: ['user_id'] },
      { fields: ['request_key'], unique: true },
      { fields: ['status'] },
      { fields: ['transaction_id'], unique: true },
      { fields: ['created_at'] },
    ],
  }
);

module.exports = Payment;
