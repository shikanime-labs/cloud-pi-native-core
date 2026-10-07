import { z } from "zod";

export const libraryName = "cloud-pi-native-core";

export const ProjectStatusSchema = z.enum([
  "initializing",
  "created",
  "failed",
  "archived",
  "warning",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const RoleTypeSchema = z.enum(["managed", "custom"]);
export type RoleType = z.infer<typeof RoleTypeSchema>;

/** Project tier: `oidcGroup` is the suffix under `/<slug>/console/`. */
export const ProjectRoleSchema = z.object({
  name: z.string().min(1),
  permissions: z.bigint(),
  position: z.number().int(),
  oidcGroup: z.string().min(1),
  type: RoleTypeSchema,
});
export type ProjectRoleSpec = z.infer<typeof ProjectRoleSchema>;

/**
 * Platform tier: same shape, but `oidcGroup` is an absolute platform path
 * (`/admin`, `/console/security`, ...).
 */
export const AdminRoleSchema = ProjectRoleSchema;
export type AdminRoleSpec = ProjectRoleSpec;

const memberRoleIds = { roleIds: z.array(z.string().min(1)) };

/** `addMember` accepts `{email} | {userId}` — exactly one identity key. */
export const ProjectMemberSchema = z.union([
  z.object({
    email: z.email(),
    userId: z.never().optional(),
    ...memberRoleIds,
  }),
  z.object({
    userId: z.string().min(1),
    email: z.never().optional(),
    ...memberRoleIds,
  }),
]);
export type ProjectMemberSpec = z.infer<typeof ProjectMemberSchema>;

export const ProjectSchema = z.object({
  /** THE join key every service module keys on. */
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  owner: z.email(),
  status: ProjectStatusSchema,
  roles: z.array(ProjectRoleSchema),
  members: z.array(ProjectMemberSchema),
});
export type ProjectSpec = z.infer<typeof ProjectSchema>;

export const ZoneSchema = z.object({
  slug: z.string().min(1).max(10),
  label: z.string().min(1),
  argocdUrl: z.url(),
});
export type ZoneSpec = z.infer<typeof ZoneSchema>;

export const ClusterPrivacySchema = z.enum(["public", "dedicated"]);
export type ClusterPrivacy = z.infer<typeof ClusterPrivacySchema>;

export const ClusterSchema = z.object({
  label: z.string().min(1),
  privacy: ClusterPrivacySchema,
  secretName: z.string().min(1),
  zoneId: z.string().min(1),
  cpu: z.number().nonnegative(),
  gpu: z.number().nonnegative(),
  memory: z.number().nonnegative(),
});
export type ClusterSpec = z.infer<typeof ClusterSchema>;

export const StageSchema = z.object({
  name: z.string().min(1),
});
export type StageSpec = z.infer<typeof StageSchema>;

export const QuotaSchema = z.object({
  memory: z.number().nonnegative(),
  cpu: z.number().nonnegative(),
  gpu: z.number().nonnegative(),
});
export type QuotaSpec = z.infer<typeof QuotaSchema>;

export const EnvironmentSchema = z.object({
  // unique per project — enforced at the collection boundary (@@unique([projectId, name]))
  name: z.string().min(1).max(11),
  projectId: z.string().min(1),
  clusterId: z.string().min(1),
  stageId: z.string().min(1),
  quota: QuotaSchema,
  autosync: z.boolean(),
});
export type EnvironmentSpec = z.infer<typeof EnvironmentSchema>;
