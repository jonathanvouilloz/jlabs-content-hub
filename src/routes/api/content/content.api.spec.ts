import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = () =>
  readFileSync(
    resolve(process.cwd(), "src/routes/api/content/+server.ts"),
    "utf8",
  );

describe("POST /api/content — checkpoint humain obligatoire", () => {
  it("conserve la protection CSRF globale de SvelteKit", () => {
    const config = readFileSync(
      resolve(process.cwd(), "svelte.config.js"),
      "utf8",
    );
    expect(config).not.toMatch(/checkOrigin:\s*false/);
  });

  it("exige les scopes machine distincts en lecture et écriture", () => {
    const code = source();
    expect(code).toContain("authorizeMachine(event, 'content:write')");
    expect(code).toContain("authorizeMachine(event, 'content:read')");
  });

  it("crée chaque contenu API en draft, y compris GMB et les calendriers", () => {
    const code = source();
    expect(code).not.toMatch(/api-auto-approve/);
    expect(code).not.toMatch(/status:\s*'approved'/);
    expect(code).toMatch(/status:\s*'draft'/);
  });

  it("ne déclenche aucun effet de publication GMB ou LinkedIn", () => {
    const code = source();
    expect(code).not.toMatch(
      /publishToGmb|createLocalPost|publishLinkedIn|fetch\([^)]*(google|linkedin)/i,
    );
  });
});
