export interface DirtyDozenCase {
  id: number;
  name: string;
  targetPath: string;
  operation: 'get' | 'list' | 'create' | 'update';
  auth: { uid: string; emailVerified: boolean } | null;
  payload?: Record<string, unknown>;
  expectedOutcome: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated access to ledger',
    targetPath: 'users/u1/ledger/main',
    operation: 'get',
    auth: null,
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified email user write',
    targetPath: 'users/u1',
    operation: 'create',
    auth: { uid: 'u1', emailVerified: false },
    payload: { uid: 'u1', email: 'u1@example.com', displayName: 'U1', photoURL: '' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-tenant PII profile read',
    targetPath: 'users/u1',
    operation: 'get',
    auth: { uid: 'u2', emailVerified: true },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'User collection enumeration via list',
    targetPath: 'users',
    operation: 'list',
    auth: { uid: 'u1', emailVerified: true },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Owner UID spoofing on ledger create',
    targetPath: 'users/u1/ledger/main',
    operation: 'create',
    auth: { uid: 'u1', emailVerified: true },
    payload: { ownerUid: 'u2', schemaVersion: 6 },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Shadow field injection (isAdmin)',
    targetPath: 'users/u1',
    operation: 'update',
    auth: { uid: 'u1', emailVerified: true },
    payload: { displayName: 'Updated', isAdmin: true },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Orphaned ledger write without parent user doc',
    targetPath: 'users/u_orphan/ledger/main',
    operation: 'create',
    auth: { uid: 'u_orphan', emailVerified: true },
    payload: { ownerUid: 'u_orphan', schemaVersion: 6 },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Disallowed ledger document ID',
    targetPath: 'users/u1/ledger/extra_doc',
    operation: 'create',
    auth: { uid: 'u1', emailVerified: true },
    payload: { ownerUid: 'u1', schemaVersion: 6 },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Malformed attachment ID poisoning',
    targetPath: 'users/u1/attachments/bad$id',
    operation: 'create',
    auth: { uid: 'u1', emailVerified: true },
    payload: { ownerUid: 'u1', attachmentId: 'bad$id', dataUrl: 'data:image/png;base64,AAA' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Immutable createdAt tampering on update',
    targetPath: 'users/u1/ledger/main',
    operation: 'update',
    auth: { uid: 'u1', emailVerified: true },
    payload: { createdAt: '1970-01-01T00:00:00Z' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Client-forged updatedAt timestamp on create',
    targetPath: 'users/u1',
    operation: 'create',
    auth: { uid: 'u1', emailVerified: true },
    payload: { uid: 'u1', email: 'u1@example.com', createdAt: 0, updatedAt: 0 },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Non-image payload in attachment dataUrl',
    targetPath: 'users/u1/attachments/att_1',
    operation: 'create',
    auth: { uid: 'u1', emailVerified: true },
    payload: { ownerUid: 'u1', attachmentId: 'att_1', dataUrl: 'javascript:alert(1)' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
];
