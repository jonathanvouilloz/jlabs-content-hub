import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createProjectProjection,
  type ProjectCreationDependencies,
} from "../../../lib/server/project-creation";

function dependencies(
  overrides: Partial<ProjectCreationDependencies> = {},
): ProjectCreationDependencies {
  return {
    findProject: vi.fn().mockResolvedValue(null),
    findCoreEntity: vi
      .fn()
      .mockResolvedValue({
        id: "b8ff1204-cb18-4d9c-bd4f-4a8bbaf00fd6",
        slug: "wildcat",
      }),
    reconcileCoreEntity: vi.fn(),
    insertProject: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("POST /api/projects — création de projection sûre", () => {
  it("crée la projection avec entity_id et ne persiste jamais le token client brut", async () => {
    const deps = dependencies();
    const result = await createProjectProjection(
      { name: "Wild Cat", slug: "wildcat" },
      deps,
    );

    expect(result.reused).toBe(false);
    if (result.reused) throw new Error("Une création neuve était attendue.");
    expect(result.accessToken).toMatch(/^stc_/);
    expect(deps.insertProject).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "wildcat",
        entityId: "b8ff1204-cb18-4d9c-bd4f-4a8bbaf00fd6",
        accessToken: expect.stringMatching(/^v2:/),
      }),
    );
    expect(
      JSON.stringify(vi.mocked(deps.insertProject).mock.calls),
    ).not.toContain(result.accessToken);
  });

  it("passe par le reconciler contrôlé et réessaie une erreur transitoire avant insertion", async () => {
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("unavailable"), { retryable: true }),
      )
      .mockResolvedValueOnce({
        id: "f7ff1204-cb18-4d9c-bd4f-4a8bbaf00fd6",
        slug: "nouveau",
      });
    const deps = dependencies({
      findCoreEntity: vi.fn().mockResolvedValue(null),
      reconcileCoreEntity: reconcile,
    });

    await createProjectProjection({ name: "Nouveau", slug: "nouveau" }, deps, {
      retryDelayMs: 0,
    });

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith({
      slug: "nouveau",
      displayName: "Nouveau",
      idempotencyKey: "seo-project:nouveau",
    });
    expect(deps.insertProject).toHaveBeenCalledOnce();
  });

  it("rend le projet existant sans nouvelle écriture lors d’un retry HTTP", async () => {
    const deps = dependencies({
      findProject: vi
        .fn()
        .mockResolvedValue({ id: "existing", slug: "wildcat" }),
    });
    const result = await createProjectProjection(
      { name: "Wild Cat", slug: "wildcat" },
      deps,
    );
    expect(result).toEqual({ id: "existing", slug: "wildcat", reused: true });
    expect(deps.insertProject).not.toHaveBeenCalled();
    expect(deps.reconcileCoreEntity).not.toHaveBeenCalled();
  });

  it("rend le gagnant sans divulguer un second token quand deux créations concourent", async () => {
    let stored: { id: string; slug: string } | null = null;
    const deps = dependencies({
      findProject: vi.fn(async () => stored),
      insertProject: vi.fn(async (project) => {
        if (stored) return false;
        stored = { id: project.id, slug: project.slug };
        return true;
      }),
    });

    const [first, second] = await Promise.all([
      createProjectProjection({ name: "Wild Cat", slug: "wildcat" }, deps),
      createProjectProjection({ name: "Wild Cat", slug: "wildcat" }, deps),
    ]);

    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(first.id).toBe(second.id);
    expect([first, second].filter((result) => !result.reused)).toHaveLength(1);
  });

  it("fait créer l’admin par une action serveur sans bearer dans le navigateur", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/routes/(app)/projects/new/+page.svelte"),
      "utf8",
    );
    const action = readFileSync(
      resolve(process.cwd(), "src/routes/(app)/projects/new/+page.server.ts"),
      "utf8",
    );
    expect(page).not.toMatch(/VITE_API_KEY|Authorization\s*:/);
    expect(page).toMatch(/<form[^>]+method="POST"/);
    expect(action).toMatch(/locals\.user/);
    expect(action).toMatch(/createProjectProjection/);
  });
});

describe("rotation du token client", () => {
  it("exige le scope projects:write et ne persiste jamais le token brut", () => {
    const code = readFileSync(
      resolve(process.cwd(), "src/routes/api/projects/[slug]/token/+server.ts"),
      "utf8",
    );
    expect(code).toMatch(/authorizeMachine\(event, ["']projects:write["']\)/);
    expect(code).toContain("createClientToken()");
    expect(code).toMatch(/accessToken:\s*token\.stored/);
    expect(code).toMatch(/access_token:\s*token\.raw/);
    expect(code).not.toContain("randomBytes");
  });
});
