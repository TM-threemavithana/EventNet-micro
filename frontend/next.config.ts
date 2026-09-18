import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: '/api/users/:path*',
        destination: 'http://user-service:5000/api/users/:path*',
      },
      {
        source: '/api/events/:path*',
        destination: 'http://event-service:5002/api/events/:path*',
      },
      {
        source: '/api/bookings/:path*',
        destination: 'http://booking-service:5001/api/bookings/:path*',
      },
      {
        source: '/api/payments/:path*',
        destination: 'http://payment-service:5003/api/payments/:path*',
      },
      {
        // Fallback for root /api
        source: '/api/:path*',
        destination: 'http://user-service:5000/api/:path*',
      }
    ];
  },
};

export default nextConfig;
