import type { AuthenticatedUser } from "../shared/types";

export function loadStudentPageModule() {
  return import("./pages/StudentPage");
}

export function loadAdminPageModule() {
  return import("./pages/AdminPage");
}

export function preloadWorkspaceRoute(user: AuthenticatedUser | null | undefined) {
  if (!user) {
    return Promise.resolve();
  }

  return user.role === "admin"
    ? loadAdminPageModule().then(() => undefined)
    : loadStudentPageModule().then(() => undefined);
}
