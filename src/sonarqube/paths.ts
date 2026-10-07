/**
 * Names, permission sets, and predicates shared by every
 * `Cpn.Sonarqube` resource. Mirrors console
 * `sonarqube.constants.ts` / `sonarqube.service.ts` exactly: same
 * permission names per role, same token name, same group-path
 * derivation from Keycloak oidc paths, so the Alchemy resources
 * reconcile against console-provisioned SonarQube state.
 */

// ---- console cluster privacy (core-domain audit) ----

export type ClusterPrivacy = "public" | "dedicated";

// ---- visibility ----

/**
 * Visibility predicate: only `public` clusters get public SonarQube
 * projects, everything else (dedicated) is private.
 */
export const visibilityForCluster = (
	privacy: ClusterPrivacy,
): "public" | "private" => (privacy === "public" ? "public" : "private");

// ---- project keys ----

/**
 * SonarQube project key — byte-for-byte the legacy console scheme
 * `<slug>-<repo>-<hmac4>`, where `hmac4` is the first 4 hex chars of
 * HMAC-SHA256(repo, key="") (golden: `my-app`+`my-repo` →
 * `my-app-my-repo-923f`). Existing projects were created with it and
 * ownership matching recomputes it.
 */
export const projectKey = (slug: string, repository: string): string =>
	`${slug}-${repository}-${hex(repoHmacBytes(repository)).slice(0, 4)}`;

// HMAC-SHA256 with the empty key: H(opad ∥ H(ipad ∥ msg)), where both
// pads are constant blocks (key zero-padded to one block).
// ponytail: fixed empty key (console convention), generalize to a keyed
// HMAC if a keyed scheme ever lands upstream.
const BLOCK = 64;

const repoHmacBytes = (repository: string): readonly number[] =>
	sha256(opad().concat(sha256(ipad().concat(utf8(repository)))));

const withByte = (byte: number): readonly number[] =>
	Array.from({ length: BLOCK }, () => byte);

const ipad = (): readonly number[] => withByte(0x36);
const opad = (): readonly number[] => withByte(0x5c);

const utf8 = (text: string): readonly number[] =>
	Array.from(new TextEncoder().encode(text));

const hex = (bytes: readonly number[]): string =>
	bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 (FIPS 180-4) over small inputs — enough for key hashes. */
const sha256 = (message: readonly number[]): readonly number[] => {
	const k = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
		0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
		0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
		0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
		0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
		0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
		0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
		0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	const bytes = [...message];
	const bitLength = bytes.length * 8;
	bytes.push(0x80);
	while (bytes.length % BLOCK !== 56) bytes.push(0);
	// 64-bit big-endian bit length — via division, NOT shifts: JS shift
	// counts wrap mod 32, so `bitLength >>> 32 === bitLength >>> 0`.
	for (let i = 7; i >= 0; i--) {
		bytes.push(Math.floor(bitLength / 2 ** (8 * i)) % 256);
	}

	const w = new Array(64).fill(0);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	// All sums are wrapped with `>>> 0` (ToUint32): unwrapped accumulation
	// exceeds float64's 2^53 exact-integer range on multi-block inputs and
	// silently loses low bits.
	let a = 0x6a09e667;
	let b = 0xbb67ae85;
	let c = 0x3c6ef372;
	let d = 0xa54ff53a;
	let e = 0x510e527f;
	let f = 0x9b05688c;
	let g = 0x1f83d9ab;
	let hh = 0x5be0cd19;
	for (let offset = 0; offset < bytes.length; offset += BLOCK) {
		for (let i = 0; i < 16; i++) {
			w[i] =
				(((bytes[offset + i * 4] ?? 0) << 24) |
					((bytes[offset + i * 4 + 1] ?? 0) << 16) |
					((bytes[offset + i * 4 + 2] ?? 0) << 8) |
					(bytes[offset + i * 4 + 3] ?? 0)) >>>
				0;
		}
		for (let i = 16; i < 64; i++) {
			const s0 =
				rotr(w[i - 15] ?? 0, 7) ^ rotr(w[i - 15] ?? 0, 18) ^ ((w[i - 15] ?? 0) >>> 3);
			const s1 =
				rotr(w[i - 2] ?? 0, 17) ^ rotr(w[i - 2] ?? 0, 19) ^ ((w[i - 2] ?? 0) >>> 10);
			w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
		}
		const pa = a;
		const pb = b;
		const pc = c;
		const pd = d;
		const pe = e;
		const pf = f;
		const pg = g;
		const phh = hh;
		for (let i = 0; i < 64; i++) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (hh + s1 + ch + (k[i] ?? 0) + (w[i] ?? 0)) >>> 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (s0 + maj) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}
		a = (a + pa) >>> 0;
		b = (b + pb) >>> 0;
		c = (c + pc) >>> 0;
		d = (d + pd) >>> 0;
		e = (e + pe) >>> 0;
		f = (f + pf) >>> 0;
		g = (g + pg) >>> 0;
		hh = (hh + phh) >>> 0;
	}
	return [a, b, c, d, e, f, g, hh].map((x) => x >>> 0).flatMap((word) => [
		(word >>> 24) & 0xff,
		(word >>> 16) & 0xff,
		(word >>> 8) & 0xff,
		word & 0xff,
	]);
};

// ---- main branch ----

/** Main branch every console-created SonarQube project pins. */
export const MAIN_BRANCH = "main";

// ---- CI robot user ----

/** Robot login the console uses per project (equals the slug). */
export const robotLogin = (slug: string): string => slug;

/** Robot email — per-project fake email avoiding SSO collisions (#2510). */
export const robotEmail = (slug: string): string =>
	`${slug}@cloud-pi-native.fr`;

/** Token name the console rotates for the CI robot. */
export const ciTokenName = (login: string): string => `Sonar Token for ${login}`;

// ---- role group paths (Keycloak oidc paths /{slug}/console/{suffix}) ----

export const PROJECT_ROLES = [
	"admin",
	"devops",
	"developer",
	"security",
	"readonly",
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Default `/{slug}/console/<suffix>` group-path suffix per role. */
export const DEFAULT_ROLE_SUFFIXES: Readonly<Record<ProjectRole, string>> = {
	admin: "/console/admin",
	devops: "/console/devops",
	developer: "/console/developer",
	security: "/console/security",
	readonly: "/console/readonly",
};

/**
 * Resolve the Keycloak group paths aliasing one project role. Console
 * semantics: a raw suffix string may be a comma-separated multi-path
 * list; each entry is trimmed, empties dropped, and concatenated as
 * `/<slug>` + suffix verbatim.
 */
export const roleGroupPaths = (
	slug: string,
	role: ProjectRole,
	rawSuffixes?: string,
): readonly string[] => {
	const raw = rawSuffixes ?? DEFAULT_ROLE_SUFFIXES[role];
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((suffix) => `/${slug}${suffix}`);
};

// ---- permission sets (SonarQube permission API names) ----

/** Project-level permissions granted to the `admin` role group. */
export const ADMIN_PERMISSIONS = [
	"admin",
	"scan",
	"user",
	"codeviewer",
	"issueadmin",
	"securityhotspotadmin",
] as const;

/** Project-level permissions for `devops`, `developer`, `security`. */
export const DEVOPS_PERMISSIONS = [
	"scan",
	"user",
	"codeviewer",
	"issueadmin",
	"securityhotspotadmin",
] as const;

/** Project-level permissions for `readonly`. */
export const READONLY_PERMISSIONS = ["user", "codeviewer"] as const;

/**
 * Permission-set derivation per role type: the mapping from a
 * {@link ProjectRole} to its SonarQube permission list. `security`
 * aliases the devops set (console grants `securityhotspotadmin`, not
 * admin).
 */
export const permissionsForRole = (role: ProjectRole): readonly string[] => {
	if (role === "admin") return ADMIN_PERMISSIONS;
	if (role === "readonly") return READONLY_PERMISSIONS;
	return DEVOPS_PERMISSIONS;
};

/** CI robot permissions — Execute Analysis + Browse + See Source Code. */
export const ROBOT_PERMISSIONS = ["scan", "user", "codeviewer"] as const;

// ---- permission templates ----

/**
 * Permission-template name derivation: one template per project, named
 * by the slug.
 */
export const permissionTemplateName = (slug: string): string => slug;

/**
 * Grant applied to a project's permission template: the project's
 * default admin group (`/{slug}/console/admin`) gets `admin` — the
 * creator-equivalent grant the console applies via
 * `add_project_creator_to_template`.
 */
export const TEMPLATE_ADMIN_GRANT = "admin" as const;

/** Template description, console-style. */
export const templateDescription = (slug: string): string =>
	`cloud-pi-native project template for ${slug}`;
