import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import { fetchProjects } from "./api";
import type { Project } from "../../types";

type ProjectsState =
  | { status: "loading" }
  | { status: "ready"; projects: Project[] }
  | { status: "error"; message: string };

/**
 * Loads the projects and hands back a `reload`.
 *
 * Like `useLots`, this re-reads after every write rather than patching the
 * local array: the counts on each project are computed server-side, so only the
 * server knows what they are after a change. A 401 on refresh goes to
 * `onSessionExpired`, not the error card.
 */
export function useProjects(enabled: boolean, onSessionExpired: () => void) {
  const [state, setState] = useState<ProjectsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", projects: await fetchProjects() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        onSessionExpired();
        return;
      }
      setState({
        status: "error",
        message: caught instanceof Error ? caught.message : "No se pudieron cargar los proyectos.",
      });
    }
  }, [onSessionExpired]);

  useEffect(() => {
    if (enabled) {
      void reload();
    }
  }, [enabled, reload]);

  return { state, reload };
}
