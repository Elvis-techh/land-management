import { api } from "../../lib/api";
import type { User } from "../../lib/permissions";

interface SessionResponse {
  user: User;
}

export const authApi = {
  /** Who is signed in? Throws ApiError(401) when nobody is. */
  me: () => api.get<SessionResponse>("/api/auth/me").then((response) => response.user),

  login: (email: string, password: string) =>
    api.post<SessionResponse>("/api/auth/login", { email, password }).then((r) => r.user),

  logout: () => api.post<{ ok: boolean }>("/api/auth/logout"),
};
