import { beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";

// Mock crypto API for Node.js environment
Object.defineProperty(global, "crypto", {
  value: webcrypto,
});

// Mock fetch globally
global.fetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});
