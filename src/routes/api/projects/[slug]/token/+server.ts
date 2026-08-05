import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/index.js";
import { projects } from "$lib/server/db/schema.js";
import {
  authorizeMachine,
  machineAuthError,
  errorResponse,
  jsonResponse,
} from "$lib/server/api-auth.js";
import { createClientToken } from "$lib/server/client-token.js";
import { eq } from "drizzle-orm";

export const POST: RequestHandler = async (event) => {
  const auth = authorizeMachine(event, "projects:write");
  if (!auth.ok) return machineAuthError(auth);

  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, event.params.slug),
  });
  if (!project) return errorResponse("Project not found", 404);

  const token = createClientToken();
  await db
    .update(projects)
    .set({
      accessToken: token.stored,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, project.id));

  return jsonResponse({
    access_token: token.raw,
    access_token_expires_at: token.expiresAt.toISOString(),
  });
};
