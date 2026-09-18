// utils/paymentApi.ts
// API client for Payment Service (runs on port 5003)

// Prefer a single ingress base like "http(s)://<ip>/api".
// Fallback to "/api" so frontend can work behind same ingress host.
const PAYMENT_API_URL = process.env.NEXT_PUBLIC_PAYMENT_API_URL || "/api";

interface PaymentApiOptions {
  method?: string;
  body?: unknown;
  token: string;
  params?: Record<string, string | number>;
}

type PaymentApiErrorResponse = {
  error?: string;
  message?: string;
};

type PaymentApiError = Error & {
  status?: number;
  data?: PaymentApiErrorResponse;
};

async function paymentClient<T = unknown>(
  endpoint: string,
  { method = "GET", body, token, params }: PaymentApiOptions
): Promise<T> {
  // Build query string
  let url = `${PAYMENT_API_URL}${endpoint}`;
  if (params) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => qs.append(k, String(v)));
    url += `?${qs.toString()}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(
      (data as PaymentApiErrorResponse).error ||
      (data as PaymentApiErrorResponse).message ||
      "Payment API error"
    ) as PaymentApiError;
    err.status = res.status;
    err.data = data as PaymentApiErrorResponse;
    throw err;
  }

  return data as T;
}

// ─── Types ──────────────────────────────────────────────────────

export interface PaymentData {
  id: string;
  bookingId: string;
  userId?: string;
  amount: number | string;
  currency: string;
  status: "pending" | "processing" | "completed" | "failed" | "refunded";
  paymentMethod: string;
  transactionId?: string;
  cardLast4?: string;
  failureReason?: string;
  refundedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CreatePaymentBody {
  bookingId: string;
  amount: number;
  currency?: string;
  paymentMethod: "credit_card" | "debit_card" | "bank_transfer" | "digital_wallet";
  cardLast4?: string;
  metadata?: Record<string, unknown>;
}

export interface PaginationInfo {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── API Methods ────────────────────────────────────────────────

/** POST /api/payments — Create a new payment */
export const createPayment = (token: string, body: CreatePaymentBody) =>
  paymentClient<{ success: boolean; message: string; data: PaymentData }>(
    "/payments",
    { method: "POST", body, token }
  );

/** GET /api/payments/user/me — Get logged-in user's payments */
export const getMyPayments = (
  token: string,
  params?: { page?: number; limit?: number; status?: string }
) =>
  paymentClient<{
    success: boolean;
    data: PaymentData[];
    pagination: PaginationInfo;
  }>("/payments/user/me", {
    token,
    params: params as Record<string, string | number>,
  });

/** GET /api/payments/:id — Get a single payment */
export const getPaymentById = (token: string, id: string) =>
  paymentClient<{ success: boolean; data: PaymentData }>(
    `/payments/${id}`,
    { token }
  );

/** GET /api/payments/booking/:bookingId — Get payments for a booking */
export const getPaymentByBooking = (token: string, bookingId: string) =>
  paymentClient<{ success: boolean; data: PaymentData[] }>(
    `/payments/booking/${bookingId}`,
    { token }
  );

/** POST /api/payments/:id/refund — Refund a payment */
export const refundPayment = (token: string, id: string) =>
  paymentClient<{ success: boolean; message: string; data: PaymentData }>(
    `/payments/${id}/refund`,
    { method: "POST", token }
  );
