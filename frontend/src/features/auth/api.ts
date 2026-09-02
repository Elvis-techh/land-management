import { api } from "../../lib/api";
import { setBusinessTimeZone } from "../../lib/businessTime";
import type { User } from "../../lib/permissions";

interface SessionResponse {
  user: User;
  /**
   * The office's timezone, as the server has it configured.
   *
   * The session response carries it because the browser has to agree with the
   * server about what day it is, and this is the one call every session makes
   * before anything is rendered. Optional on the type so an older server that
   * does not send it leaves the built-in fallback in place rather than blanking
   * the zone.
   */
  businessTimeZone?: string;
}

/**
 * Adopt whatever the server said, then hand back the user.
 *
 * Applied here rather than in a component, so there is no window in which a
 * dialog can open and pre-fill a date before the zone has been set.
 */
function adopt(response: SessionResponse): User {
  if (response.businessTimeZone) {
    setBusinessTimeZone(response.businessTimeZone);
  }

  return response.user;
}

export const authApi = {
  /** Who is signed in? Throws ApiError(401) when nobody is. */
  me: () => api.get<SessionResponse>("/api/auth/me").then(adopt),

  login: (email: string, password: string) =>
    api.post<SessionResponse>("/api/auth/login", { email, password }).then(adopt),

  logout: () => api.post<{ ok: boolean }>("/api/auth/logout"),
};
