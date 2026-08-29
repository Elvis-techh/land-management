import { api } from "../../lib/api";
import { toAreaUnit } from "../../lib/area";
import { cents } from "../../lib/money";
import type { Project } from "../../types";

interface ProjectsResponse {
  projects: Array<{
    id: string;
    name: string;
    areaUnit: string;
    archivedAt: string | null;
    lotCount: number;
    availableCount: number;
    reservedCount: number;
    soldCount: number;
    inventoryValue: number;
    areaM2: number;
  }>;
}

/** Fetch every project, archived ones included — the screen shows both. */
export async function fetchProjects(): Promise<Project[]> {
  const response = await api.get<ProjectsResponse>("/api/projects");

  return response.projects.map((project) => ({
    ...project,
    // Money and units are branded/narrowed here, at the boundary, exactly as
    // the lots API does.
    areaUnit: toAreaUnit(project.areaUnit),
    inventoryValue: cents(project.inventoryValue),
  }));
}

export interface ProjectDraft {
  name: string;
  areaUnit: string;
}

export function createProject(draft: ProjectDraft) {
  return api.post<{ project: { id: string; name: string } }>("/api/projects", draft);
}

export function updateProject(projectId: string, draft: ProjectDraft) {
  return api.patch<{ project: { id: string; name: string } }>(
    `/api/projects/${projectId}`,
    draft,
  );
}

export function archiveProject(projectId: string, reason: string) {
  return api.post<{ ok: boolean }>(`/api/projects/${projectId}/archive`, { reason });
}

export function restoreProject(projectId: string) {
  return api.post<{ ok: boolean }>(`/api/projects/${projectId}/restore`);
}
