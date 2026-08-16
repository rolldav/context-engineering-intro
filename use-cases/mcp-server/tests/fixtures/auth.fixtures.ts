import type { Props } from "../../src/types";

export const mockProps: Props = {
  login: "testuser",
  name: "Test User",
  email: "test@example.com",
  permissions: [],
};

export const mockPrivilegedProps: Props = {
  login: "trusted-writer",
  name: "Trusted Writer",
  email: "writer@example.com",
  permissions: ["database:write"],
};

export const mockGitHubUser = {
  data: {
    login: "testuser",
    name: "Test User",
    email: "test@example.com",
    id: 12345,
    avatar_url: "https://github.com/images/avatar.png",
  },
};

export const mockAuthRequest = {
  clientId: "test-client-id",
  redirectUri: "http://localhost:3000/callback",
  responseType: "code",
  scope: ["mcp"],
  state: "test-state",
  codeChallenge: "test-challenge",
  codeChallengeMethod: "S256",
};

export const mockClientInfo = {
  clientId: "test-client-id",
  clientName: "Test Client",
  redirectUris: ["http://localhost:3000/callback"],
  tokenEndpointAuthMethod: "none",
};

export const mockAccessToken = "github-access-token-123";
export const mockAuthorizationCode = "auth-code-456";
export const mockState = "oauth-state-789";
