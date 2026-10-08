export * from "./admin-role.ts";
export * from "./derive.ts";
export * from "./project.ts";
export * from "./provider.ts";
export * from "./zone.ts";

// ---------------------------------------------------------------------------
// Domain aliases — core-domain types whose entire service footprint is ONE
// already-extracted resource. Re-exported under the composite barrel so the
// full domain is addressable from one import; see docs/audit/domain-remap.md
// for the classification ledger.
// ---------------------------------------------------------------------------

/** Domain Environment → its single service child (ArgoCD values file). */
export { EnvironmentValues as CpnEnvironment } from "../argocd/index.ts";
/** Domain Repository → its single service child (GitLab repository). */
export { Repository as CpnRepository } from "../gitlab/index.ts";
/** Domain ProjectRole → its single service child (Keycloak role group). */
export { RoleGroupMembers as CpnProjectRole } from "../keycloak/index.ts";
