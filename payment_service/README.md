# 💳 Payment Service

Payment microservice for the **Event Ticket Booking Platform** — Cloud Computing Assignment (EC7205).

## Architecture

```
Client → API Gateway → Payment Service → PostgreSQL
                              ↕
                          RabbitMQ (async messaging)
                              ↕
                       Booking Service
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 18 |
| Framework | Express.js |
| Database | PostgreSQL 15 (Sequelize ORM) |
| Message Queue | RabbitMQ 3 |
| Auth | JWT (shared secret with User Service) |
| Security | Helmet.js, CORS, Rate Limiting |
| Containerization | Docker + Docker Compose |

## API Endpoints

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/payments/health` | Health check | ❌ |
| `POST` | `/api/payments` | Create payment | ✅ |
| `GET` | `/api/payments/:id` | Get payment by ID | ✅ |
| `GET` | `/api/payments/booking/:bookingId` | Get by booking ID | ✅ |
| `GET` | `/api/payments/user/me` | Get my payments | ✅ |
| `POST` | `/api/payments/:id/refund` | Refund payment | ✅ |

## Message Queue Events

| Queue | Direction | Event |
|-------|-----------|-------|
| `payment.request` | ← Consume | Payment request from Booking Service |
| `payment-result-queue` | → Publish | Payment succeeded or failed |
| `payment.refunded` | → Publish | Payment refunded |

## Quick Start

### Start the service with Docker Compose

```bash
# From payment_service/: start Payment, PostgreSQL, and RabbitMQ
docker compose up --build -d

# Confirm the HTTP service is ready
curl http://localhost:5003/api/payments/health

# Follow service logs when troubleshooting
docker compose logs -f payment-service

# Stop services
docker compose down

# Stop and also remove local database/queue data
docker compose down --volumes
```

RabbitMQ's management UI is available at `http://localhost:15673` (`guest` / `guest`).
The compose file exposes PostgreSQL on port `5433` and AMQP on port `5673`, while
containers use their normal internal ports.

### Run the integration tests in Docker

The test stack is isolated from the development stack and creates disposable
PostgreSQL and RabbitMQ containers. Docker is the only prerequisite.

```bash
# From payment_service/
docker compose -f docker-compose.test.yml up \
  --build \
  --abort-on-container-exit \
  --exit-code-from payment-tests

# Always remove test containers and volumes afterward
docker compose -f docker-compose.test.yml down --volumes
```

The suite exercises the authenticated payment/refund API against PostgreSQL and
asserts actual RabbitMQ messages. It also publishes the same payment request
twice and verifies that one payment is stored while the existing result is
re-emitted for the duplicate delivery.

### Run the Node process locally

**Prerequisites:** PostgreSQL and RabbitMQ must be running locally.

```bash
# Install dependencies
npm install

# Configure DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
# RABBITMQ_URL, and JWT_SECRET in your shell or a local .env file.

# Start development server (with hot reload)
npm run dev

# Start production server
npm start
```

## Project Structure

```
payment-service/
├── src/
│   ├── config/
│   │   ├── db.js              # PostgreSQL connection (Sequelize)
│   │   ├── rabbitmq.js        # RabbitMQ connection & channels
│   │   └── env.js             # Environment configuration
│   ├── models/
│   │   └── Payment.js         # Payment model (Sequelize)
│   ├── controllers/
│   │   └── paymentController.js
│   ├── routes/
│   │   └── paymentRoutes.js
│   ├── services/
│   │   ├── paymentProcessor.js  # Simulated Stripe gateway
│   │   └── messageQueue.js      # RabbitMQ pub/sub service
│   ├── middleware/
│   │   ├── auth.js              # JWT authentication
│   │   └── errorHandler.js      # Global error handler
│   └── app.js                   # Entry point
├── migrations/                   # Production schema changes
├── test/                         # Unit and integration tests
├── Dockerfile
├── Dockerfile.test
├── docker-compose.yml
├── docker-compose.test.yml
└── package.json
```

## Testing with cURL

```bash
# Health check
curl http://localhost:5003/api/payments/health

# Create a payment (replace TOKEN with a valid JWT)
curl -X POST http://localhost:5003/api/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "bookingId": 1234,
    "amount": 49.99,
    "currency": "USD",
    "paymentMethod": "credit_card",
    "cardLast4": "4242"
  }'

# Get payment by ID
curl http://localhost:5003/api/payments/PAYMENT_ID \
  -H "Authorization: Bearer TOKEN"

# Refund a payment
curl -X POST http://localhost:5003/api/payments/PAYMENT_ID/refund \
  -H "Authorization: Bearer TOKEN"
```

## Test Cards

| Card Last 4 | Behavior |
|-------------|----------|
| `4242` | ✅ Success |
| `0000` | ❌ Declined (Insufficient funds) |
| `1111` | ❌ Gateway timeout |
| Any other | ✅ Success |

## Duplicate-delivery behavior

RabbitMQ is an at-least-once transport, so consumers must expect redelivery.
Queue-originated payments store a unique `request_key`: the AMQP `messageId`
when supplied, or `booking:<bookingId>` for the current Booking Service, which
does not set one. A duplicate request does not call the payment processor or
insert another payment. If the original payment is already completed or failed,
the service publishes that result again so a downstream consumer that missed
the first event can recover.

This scope deliberately applies only to queue-originated payments. The REST API
has no client idempotency-key contract yet; adding one would require an explicit
public API decision about retry keys and retention.

### Production schema update

Development and test databases are synchronized by Sequelize. Before deploying
this change to an existing production database, apply the checked-in migration:

```bash
PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -f migrations/001_add_payment_request_key.sql
```

This is intentionally a separate deployment step: the service does not run
destructive schema alteration automatically in production.

## Cloud-Native Features

- **Scalability**: Stateless service, horizontal scaling via Docker replicas
- **High Availability**: Health checks, auto-reconnection, graceful shutdown
- **Security**: JWT auth, Helmet.js, rate limiting, input validation, non-root Docker user
- **Async Communication**: RabbitMQ event-driven messaging
- **Deployment**: Docker + Docker Compose with health-based startup ordering
