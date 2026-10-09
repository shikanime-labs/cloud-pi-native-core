import type { GroupVersionKind } from "kubernetes-fluent-client";
import { GenericKind, RegisterKind } from "kubernetes-fluent-client";

/**
 * CRD kinds the operator reconciles, one class per kind so the
 * kubernetes-fluent-client watch can resolve the GroupVersionKind.
 */

export const GROUP = "cpn.shikanime.studio";
export const VERSION = "v1alpha1";

class CpnProject extends GenericKind {}
class CpnAdminRole extends GenericKind {}
class CpnZone extends GenericKind {}
class CpnCluster extends GenericKind {}

const register = (model: abstract new () => unknown, kind: string): void => {
	RegisterKind(model as never, {
		kind,
		version: VERSION,
		group: GROUP,
	} satisfies GroupVersionKind);
};

register(CpnProject, "Project");
register(CpnAdminRole, "AdminRole");
register(CpnZone, "Zone");
register(CpnCluster, "Cluster");

/** Kind name → watchable model class. */
export const CpnKinds = {
	Project: CpnProject,
	AdminRole: CpnAdminRole,
	Zone: CpnZone,
	Cluster: CpnCluster,
} as const;

export type CpnKindName = keyof typeof CpnKinds;
