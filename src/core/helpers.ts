/** Derive the OIDC group path for a project role suffix. */
export const roleGroupPath = (slug: string, suffix: string): string =>
  `/${slug}/console/${suffix}`;

export const grantPermissions = (base: bigint, ...bits: bigint[]): bigint =>
  bits.reduce((acc, bit) => acc | bit, base);

export const revokePermissions = (base: bigint, ...bits: bigint[]): bigint =>
  bits.reduce((acc, bit) => acc & ~bit, base);

/** True when every bit in `bit` is present in `permissions`. */
export const hasPermission = (permissions: bigint, bit: bigint): boolean =>
  (permissions & bit) === bit;
