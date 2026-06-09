/** @type {import('next').NextConfig} */
const nextConfig = {
  // The pipeline reads env at runtime; nothing exotic needed.
  experimental: {
    // server actions are stable in 15, kept here for clarity if limits need tuning
  },
};

export default nextConfig;
