import { vi } from "vitest";
import { mockGitHubUser, mockAccessToken } from "../fixtures/auth.fixtures";

// Mock Octokit
export const mockOctokit = {
  rest: {
    users: {
      getAuthenticated: vi.fn(),
    },
  },
};

vi.mock("octokit", () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

// Mock GitHub API responses
export function setupGitHubMocks() {
  mockOctokit.rest.users.getAuthenticated.mockResolvedValue(mockGitHubUser);
}

export function setupGitHubError() {
  mockOctokit.rest.users.getAuthenticated.mockRejectedValue(new Error("GitHub API error"));
}

export function setupGitHubUnauthorized() {
  mockOctokit.rest.users.getAuthenticated.mockRejectedValue(new Error("Bad credentials"));
}

export function resetGitHubMocks() {
  vi.clearAllMocks();
  setupGitHubMocks();
}

// Mock fetch for GitHub OAuth token exchange
export function setupGitHubTokenExchange() {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes("github.com/login/oauth/access_token")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: mockAccessToken, token_type: "bearer", scope: "read:user" }),
      } as Response);
    }
    return Promise.reject(new Error("Unexpected fetch call"));
  }) as typeof fetch;
}

export function setupGitHubTokenExchangeError() {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes("github.com/login/oauth/access_token")) {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "invalid_grant" }),
      } as Response);
    }
    return Promise.reject(new Error("Unexpected fetch call"));
  }) as typeof fetch;
}
