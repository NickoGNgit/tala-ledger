import {initializeApp} from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export type SyncStatusKind = 'signed_out' | 'syncing' | 'synced' | 'offline' | 'conflict' | 'error';

export interface CloudUserInfo {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
}

export interface ConflictSummary {
  localCount: number;
  cloudCount: number;
  localUpdatedAt: number;
  cloudUpdatedAt: number;
}

export interface CloudSyncStatus {
  ready: boolean;
  user: CloudUserInfo | null;
  syncState: SyncStatusKind;
  lastSyncedAt: number | null;
  errorMessage: string | null;
  conflictSummary: ConflictSummary | null;
}

type SyncListener = (status: CloudSyncStatus) => void;

interface LedgerHostBridge {
  getLocalState: () => Record<string, unknown>;
  applyRemoteState: (remoteState: Record<string, unknown>) => void;
  hasMeaningfulData?: (st: Record<string, unknown>) => boolean;
  showToast?: (message: string, isError?: boolean) => void;
}

const DEVICE_ID_KEY = 'tala_device_id';
const LINKED_UID_KEY = 'tala_cloud_linked_uid';
const DIRTY_FLAG_KEY = 'tala_cloud_dirty';
const LOCAL_UPDATED_KEY = 'tala_local_updated_at';
const ATT_REF_PREFIX = '__attRef:';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const databaseId = (firebaseConfig as {firestoreDatabaseId?: string}).firestoreDatabaseId?.trim() || undefined;
let db: Firestore;
try {
  db = initializeFirestore(
    app,
    {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    },
    databaseId
  );
} catch {
  db = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
}

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({prompt: 'select_account'});

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function getDocServerFirst(ref: ReturnType<typeof doc>) {
  try {
    return await getDocFromServer(ref);
  } catch (err: unknown) {
    const code = (err as {code?: string})?.code || '';
    const msg = err instanceof Error ? err.message : '';
    if (code === 'permission-denied' || msg.includes('Missing or insufficient permissions')) {
      throw err;
    }
    return await getDoc(ref);
  }
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id || !/^[a-zA-Z0-9_-]{4,64}$/.test(id)) {
      id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'dev_' + Date.now().toString(36);
  }
}

function hashAttachmentId(dataUrl: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < dataUrl.length; i++) {
    const ch = dataUrl.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const part1 = (h1 >>> 0).toString(36);
  const part2 = (h2 >>> 0).toString(36);
  return 'att_' + part1 + '_' + part2 + '_' + dataUrl.length.toString(36);
}

function stripUndefined<T>(value: T): T {
  if (value === undefined) {
    return null as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : stripUndefined(item))) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  const src = value as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (src[key] !== undefined) {
      out[key] = stripUndefined(src[key]);
    }
  }
  return out as T;
}

function countLedgerItems(st: Record<string, unknown> | null | undefined): number {
  if (!st || typeof st !== 'object') return 0;
  const keys = [
    'payouts',
    'recurringTemplates',
    'savingsAccounts',
    'payables',
    'receivables',
    'remittances',
    'creditCards',
    'bills',
  ];
  let total = 0;
  for (const k of keys) {
    const v = st[k];
    if (Array.isArray(v)) total += v.length;
  }
  return total;
}

function mergeById(localArr: unknown, cloudArr: unknown): unknown[] {
  const map = new Map<string, Record<string, unknown>>();
  const out: Record<string, unknown>[] = [];
  const ingest = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id : null;
      if (id) {
        if (!map.has(id)) {
          map.set(id, rec);
          out.push(rec);
        } else {
          // Prefer whichever has more nested records or newer timestamp
          const existing = map.get(id)!;
          const existingLen = JSON.stringify(existing).length;
          const incomingLen = JSON.stringify(rec).length;
          if (incomingLen > existingLen) {
            const idx = out.indexOf(existing);
            if (idx !== -1) out[idx] = rec;
            map.set(id, rec);
          }
        }
      } else {
        out.push(rec);
      }
    }
  };
  ingest(cloudArr);
  ingest(localArr);
  return out;
}

function mergeLedgerStates(localSt: Record<string, unknown>, cloudSt: Record<string, unknown>): Record<string, unknown> {
  const merged = JSON.parse(JSON.stringify(cloudSt)) as Record<string, unknown>;
  const listFields = [
    'payouts',
    'recurringTemplates',
    'savingsAccounts',
    'payables',
    'receivables',
    'remittances',
    'creditCards',
    'bills',
  ];
  for (const field of listFields) {
    merged[field] = mergeById(localSt[field], cloudSt[field]);
  }
  // Merge savedNames cleanly
  const localNames = (localSt.savedNames as Record<string, unknown>) || {};
  const cloudNames = (cloudSt.savedNames as Record<string, unknown>) || {};
  const mergeStrList = (a: unknown, b: unknown) => {
    const seen = new Set<string>();
    const res: string[] = [];
    for (const src of [b, a]) {
      if (!Array.isArray(src)) continue;
      for (const s of src) {
        const clean = String(s || '').trim();
        if (!clean) continue;
        const k = clean.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          res.push(clean);
        }
      }
    }
    return res;
  };
  merged.savedNames = {
    savings: mergeStrList(localNames.savings, cloudNames.savings),
    remittances: mergeStrList(localNames.remittances, cloudNames.remittances),
  };

  // Merge billNotifications inbox & logs
  const localNotif = (localSt.billNotifications as Record<string, unknown>) || {};
  const cloudNotif = (cloudSt.billNotifications as Record<string, unknown>) || {};
  merged.billNotifications = {
    enabled: localNotif.enabled !== false && cloudNotif.enabled !== false,
    dismissedToday: {
      ...((cloudNotif.dismissedToday as Record<string, unknown>) || {}),
      ...((localNotif.dismissedToday as Record<string, unknown>) || {}),
    },
    sentPushLog: {
      ...((cloudNotif.sentPushLog as Record<string, unknown>) || {}),
      ...((localNotif.sentPushLog as Record<string, unknown>) || {}),
    },
    deletedKeys: {
      ...((cloudNotif.deletedKeys as Record<string, unknown>) || {}),
      ...((localNotif.deletedKeys as Record<string, unknown>) || {}),
    },
    items: mergeById(localNotif.items, cloudNotif.items),
  };

  if (!merged.activePayoutId && localSt.activePayoutId) merged.activePayoutId = localSt.activePayoutId;
  if (!merged.activeSavingsAccountId && localSt.activeSavingsAccountId) {
    merged.activeSavingsAccountId = localSt.activeSavingsAccountId;
  }
  if (!merged.activePayableId && localSt.activePayableId) merged.activePayableId = localSt.activePayableId;
  if (!merged.activeReceivableId && localSt.activeReceivableId) {
    merged.activeReceivableId = localSt.activeReceivableId;
  }
  if (!merged.activeRemittanceId && localSt.activeRemittanceId) {
    merged.activeRemittanceId = localSt.activeRemittanceId;
  }
  return merged;
}

class TalaCloudSyncManager {
  private bridge: LedgerHostBridge | null = null;
  private listeners = new Set<SyncListener>();
  private currentUser: User | null = null;
  private unsubLedger: Unsubscribe | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private authInitPromise: Promise<void> | null = null;
  private pushInFlight: Promise<void> | null = null;
  private hasQueuedPush = false;
  private queuedPushState: Record<string, unknown> | undefined = undefined;
  private hasCloudLedgerDoc = false;
  private lastPushedAt = 0;
  private pendingConflictCloud: Record<string, unknown> | null = null;
  private pendingConflictCloudUpdatedAt = 0;
  private attachmentCache = new Map<string, string>();
  private uploadedAttachmentIds = new Set<string>();
  private isApplyingRemote = false;
  private status: CloudSyncStatus = {
    ready: false,
    user: null,
    syncState: 'signed_out',
    lastSyncedAt: null,
    errorMessage: null,
    conflictSummary: null,
  };

  constructor() {
    onAuthStateChanged(auth, (user) => {
      void this.handleAuthChanged(user);
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.currentUser && this.status.syncState !== 'conflict') {
          if (localStorage.getItem(DIRTY_FLAG_KEY) === '1') {
            void this.pushNow();
          } else {
            this.updateStatus({syncState: 'synced', errorMessage: null});
          }
        }
      });
      window.addEventListener('offline', () => {
        if (this.currentUser) {
          this.updateStatus({syncState: 'offline'});
        }
      });
    }
  }

  public registerBridge(bridge: LedgerHostBridge) {
    this.bridge = bridge;
    this.emit();
    if (this.currentUser && this.status.ready) {
      void this.handleAuthChanged(this.currentUser);
    }
  }

  public getStatus(): CloudSyncStatus {
    return {...this.status};
  }

  public subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    const snap = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (err) {
        console.error('Sync listener error:', err);
      }
    }
  }

  private updateStatus(patch: Partial<CloudSyncStatus>) {
    this.status = {...this.status, ...patch};
    this.emit();
  }

  private toCloudUser(user: User): CloudUserInfo {
    return {
      uid: user.uid,
      email: String(user.email || '').slice(0, 320),
      displayName: String(user.displayName || user.email || 'Google User').slice(0, 128),
      photoURL: String(user.photoURL || '').slice(0, 512),
    };
  }

  public async signInWithGoogle(): Promise<boolean> {
    try {
      this.updateStatus({syncState: 'syncing', errorMessage: null});
      await signInWithPopup(auth, googleProvider);
      return true;
    } catch (err: unknown) {
      const code = (err as {code?: string})?.code || '';
      let msg = 'Could not sign in with Google. Please try again.';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        msg = 'Google sign-in was cancelled.';
      } else if (code === 'auth/popup-blocked') {
        msg = 'Sign-in popup was blocked by the browser. Please allow popups for this site.';
      } else if (code === 'auth/unauthorized-domain') {
        msg =
          'This domain is not authorized in Firebase Console yet. Add this hostname under Firebase Authentication → Settings → Authorized domains.';
      } else if (code === 'auth/network-request-failed') {
        msg = 'Network error during Google sign-in. Check your internet connection.';
      }
      this.updateStatus({
        syncState: this.currentUser ? 'error' : 'signed_out',
        errorMessage: msg,
      });
      this.bridge?.showToast?.(msg, true);
      return false;
    }
  }

  public async signOutGoogle(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.unsubLedger) {
      this.unsubLedger();
      this.unsubLedger = null;
    }
    this.pendingConflictCloud = null;
    this.hasCloudLedgerDoc = false;
    this.uploadedAttachmentIds.clear();
    try {
      localStorage.removeItem(LINKED_UID_KEY);
      localStorage.removeItem(DIRTY_FLAG_KEY);
    } catch {
      /* ignore */
    }
    await signOut(auth);
    this.currentUser = null;
    this.updateStatus({
      ready: true,
      user: null,
      syncState: 'signed_out',
      lastSyncedAt: null,
      errorMessage: null,
      conflictSummary: null,
    });
    this.bridge?.showToast?.('Signed out of Google Sync. Local data remains on this device.');
  }

  public schedulePush(localState?: Record<string, unknown>) {
    if (this.isApplyingRemote) return;
    const now = Date.now();
    try {
      localStorage.setItem(LOCAL_UPDATED_KEY, String(now));
      localStorage.setItem(DIRTY_FLAG_KEY, '1');
    } catch {
      /* ignore */
    }

    if (!this.currentUser) return;
    if (this.status.syncState === 'conflict') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.updateStatus({syncState: 'offline'});
      return;
    }

    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.pushNow(localState);
    }, 650);
  }

  public async syncNow(): Promise<void> {
    if (!this.currentUser) {
      await this.signInWithGoogle();
      return;
    }
    if (this.status.syncState === 'conflict') {
      this.bridge?.showToast?.('Choose how to resolve sync conflict in Settings.', true);
      return;
    }
    await this.pushNow();
  }

  public async resolveConflict(choice: 'cloud' | 'local' | 'merge'): Promise<void> {
    if (!this.currentUser || !this.bridge || !this.pendingConflictCloud) return;
    const cloudDoc = this.pendingConflictCloud;
    const uid = this.currentUser.uid;
    this.pendingConflictCloud = null;

    if (choice === 'cloud') {
      const hydrated = await this.hydrateAttachments(uid, cloudDoc);
      this.applyRemoteStateSafely(hydrated);
      try {
        localStorage.setItem(LINKED_UID_KEY, uid);
        localStorage.removeItem(DIRTY_FLAG_KEY);
      } catch {
        /* ignore */
      }
      this.updateStatus({
        syncState: 'synced',
        lastSyncedAt: Date.now(),
        conflictSummary: null,
        errorMessage: null,
      });
      this.bridge.showToast?.('Synced your data from Google Cloud.');
      return;
    }

    if (choice === 'merge') {
      const hydratedCloud = await this.hydrateAttachments(uid, cloudDoc);
      const merged = mergeLedgerStates(this.bridge.getLocalState(), hydratedCloud);
      this.applyRemoteStateSafely(merged);
    }

    try {
      localStorage.setItem(LINKED_UID_KEY, uid);
    } catch {
      /* ignore */
    }
    this.updateStatus({syncState: 'syncing', conflictSummary: null, errorMessage: null});
    await this.pushNow(this.bridge.getLocalState());
    this.bridge.showToast?.(
      choice === 'merge' ? 'Merged local and cloud data and synced.' : 'Updated Google Cloud with your local data.'
    );
  }

  private applyRemoteStateSafely(hydrated: Record<string, unknown>) {
    if (!this.bridge) return;
    this.isApplyingRemote = true;
    try {
      this.bridge.applyRemoteState(hydrated);
    } finally {
      this.isApplyingRemote = false;
    }
  }

  private async ensureUserProfileDoc(user: User): Promise<void> {
    const path = `users/${user.uid}`;
    const userRef = doc(db, 'users', user.uid);
    const info = this.toCloudUser(user);
    try {
      const snap = await getDocServerFirst(userRef);
      if (!snap.exists()) {
        await setDoc(userRef, {
          uid: user.uid,
          email: info.email,
          displayName: info.displayName,
          photoURL: info.photoURL,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(userRef, {
          email: info.email,
          displayName: info.displayName,
          photoURL: info.photoURL,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }

  private async offloadAttachments(uid: string, rawState: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cloned = stripUndefined(JSON.parse(JSON.stringify(rawState))) as Record<string, unknown>;
    const pendingUploads: {id: string; dataUrl: string}[] = [];

    const processAttachmentValue = (val: unknown): string | null => {
      if (typeof val !== 'string' || !val) return null;
      if (val.startsWith(ATT_REF_PREFIX)) return val;
      if (val.startsWith('data:image/')) {
        const attId = hashAttachmentId(val);
        this.attachmentCache.set(attId, val);
        if (!this.uploadedAttachmentIds.has(attId)) {
          pendingUploads.push({id: attId, dataUrl: val});
        }
        return ATT_REF_PREFIX + attId;
      }
      return null;
    };

    if (Array.isArray(cloned.recurringTemplates)) {
      for (const tpl of cloned.recurringTemplates) {
        if (tpl && typeof tpl === 'object') {
          const t = tpl as Record<string, unknown>;
          t.attachment = processAttachmentValue(t.attachment);
        }
      }
    }

    if (Array.isArray(cloned.payouts)) {
      for (const pay of cloned.payouts) {
        if (pay && typeof pay === 'object' && Array.isArray((pay as Record<string, unknown>).deductions)) {
          const deds = (pay as Record<string, unknown>).deductions as unknown[];
          for (const ded of deds) {
            if (ded && typeof ded === 'object') {
              const d = ded as Record<string, unknown>;
              d.attachment = processAttachmentValue(d.attachment);
            }
          }
        }
      }
    }

    for (const item of pendingUploads) {
      if (item.dataUrl.length > 890000) continue;
      const attPath = `users/${uid}/attachments/${item.id}`;
      const attRef = doc(db, 'users', uid, 'attachments', item.id);
      try {
        const snap = await getDoc(attRef);
        if (!snap.exists()) {
          await setDoc(attRef, {
            ownerUid: uid,
            attachmentId: item.id,
            dataUrl: item.dataUrl,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        this.uploadedAttachmentIds.add(item.id);
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, attPath);
      }
    }

    return cloned;
  }

  private async hydrateAttachments(uid: string, cloudDoc: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cloned = JSON.parse(JSON.stringify(cloudDoc)) as Record<string, unknown>;
    const neededIds = new Set<string>();

    const collectId = (val: unknown) => {
      if (typeof val === 'string' && val.startsWith(ATT_REF_PREFIX)) {
        const id = val.slice(ATT_REF_PREFIX.length);
        if (id && !this.attachmentCache.has(id)) {
          neededIds.add(id);
        }
      }
    };

    if (Array.isArray(cloned.recurringTemplates)) {
      for (const tpl of cloned.recurringTemplates) {
        if (tpl && typeof tpl === 'object') {
          collectId((tpl as Record<string, unknown>).attachment);
        }
      }
    }
    if (Array.isArray(cloned.payouts)) {
      for (const pay of cloned.payouts) {
        if (pay && typeof pay === 'object' && Array.isArray((pay as Record<string, unknown>).deductions)) {
          for (const ded of (pay as Record<string, unknown>).deductions as unknown[]) {
            if (ded && typeof ded === 'object') {
              collectId((ded as Record<string, unknown>).attachment);
            }
          }
        }
      }
    }

    if (neededIds.size > 0) {
      const colPath = `users/${uid}/attachments`;
      try {
        const allSnaps = await getDocs(collection(db, 'users', uid, 'attachments'));
        allSnaps.forEach((docSnap) => {
          const data = docSnap.data();
          if (data && typeof data.attachmentId === 'string' && typeof data.dataUrl === 'string') {
            this.attachmentCache.set(data.attachmentId, data.dataUrl);
            this.uploadedAttachmentIds.add(data.attachmentId);
          }
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, colPath);
      }
    }

    const resolveVal = (val: unknown): string | null => {
      if (typeof val !== 'string') return null;
      if (val.startsWith(ATT_REF_PREFIX)) {
        const id = val.slice(ATT_REF_PREFIX.length);
        return this.attachmentCache.get(id) || null;
      }
      return val.startsWith('data:image/') ? val : null;
    };

    if (Array.isArray(cloned.recurringTemplates)) {
      for (const tpl of cloned.recurringTemplates) {
        if (tpl && typeof tpl === 'object') {
          const t = tpl as Record<string, unknown>;
          t.attachment = resolveVal(t.attachment);
        }
      }
    }
    if (Array.isArray(cloned.payouts)) {
      for (const pay of cloned.payouts) {
        if (pay && typeof pay === 'object' && Array.isArray((pay as Record<string, unknown>).deductions)) {
          for (const ded of (pay as Record<string, unknown>).deductions as unknown[]) {
            if (ded && typeof ded === 'object') {
              const d = ded as Record<string, unknown>;
              d.attachment = resolveVal(d.attachment);
            }
          }
        }
      }
    }

    return cloned;
  }

  private async pushNow(explicitLocalState?: Record<string, unknown>): Promise<void> {
    if (this.authInitPromise) {
      await this.authInitPromise;
    }
    if (!this.currentUser || !this.bridge) return;
    if (this.status.syncState === 'conflict') return;
    if (this.pushInFlight) {
      this.hasQueuedPush = true;
      this.queuedPushState = explicitLocalState;
      await this.pushInFlight;
      return;
    }

    const run = async () => {
      await this.executePushNow(explicitLocalState);
      while (this.hasQueuedPush) {
        this.hasQueuedPush = false;
        const nextState = this.queuedPushState;
        this.queuedPushState = undefined;
        await this.executePushNow(nextState);
      }
    };

    this.pushInFlight = run().finally(() => {
      this.pushInFlight = null;
    });
    await this.pushInFlight;
  }

  private async executePushNow(explicitLocalState?: Record<string, unknown>): Promise<void> {
    if (!this.currentUser || !this.bridge) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.updateStatus({syncState: 'offline'});
      return;
    }

    const uid = this.currentUser.uid;
    const ledgerPath = `users/${uid}/ledger/main`;
    const ledgerRef = doc(db, 'users', uid, 'ledger', 'main');
    const nowMs = Date.now();
    const devId = getDeviceId().slice(0, 64) || 'dev_default';

    this.updateStatus({syncState: 'syncing', errorMessage: null});

    try {
      await this.ensureUserProfileDoc(this.currentUser);
      const localRaw = explicitLocalState || this.bridge.getLocalState();
      const cleaned = await this.offloadAttachments(uid, localRaw);
      const rawPrefs = (cleaned.preferences as Record<string, unknown>) || {};
      const rawMeta = (cleaned.scheduleMeta as Record<string, unknown>) || {};
      const rawNotif = (cleaned.billNotifications as Record<string, unknown>) || {};
      const rawNames = (cleaned.savedNames as Record<string, unknown>) || {};
      const toSafeId = (val: unknown): string | null => {
        if (typeof val !== 'string') return null;
        const trimmed = val.trim();
        return trimmed ? trimmed.slice(0, 128) : null;
      };
      const baseFields = {
        schemaVersion: Math.min(100, Math.max(1, Math.trunc(Number(cleaned.schemaVersion) || 6))),
        clientUpdatedAt: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
        deviceId: devId,
        preferences: {
          theme: typeof rawPrefs.theme === 'string' ? rawPrefs.theme : 'light',
          accent: typeof rawPrefs.accent === 'string' ? rawPrefs.accent : 'blue',
          viewMode: typeof rawPrefs.viewMode === 'string' ? rawPrefs.viewMode : 'mobile',
          activeTab: typeof rawPrefs.activeTab === 'string' ? rawPrefs.activeTab : 'salary',
          payoutSort: typeof rawPrefs.payoutSort === 'string' ? rawPrefs.payoutSort : 'desc',
        },
        scheduleMeta: {
          payoutsPerMonth: Number(rawMeta.payoutsPerMonth) || 2,
          wholeYearUsed: Boolean(rawMeta.wholeYearUsed),
        },
        activePayoutId: toSafeId(cleaned.activePayoutId),
        payouts: Array.isArray(cleaned.payouts) ? cleaned.payouts.slice(0, 500) : [],
        recurringTemplates: Array.isArray(cleaned.recurringTemplates) ? cleaned.recurringTemplates.slice(0, 200) : [],
        activeSavingsAccountId: toSafeId(cleaned.activeSavingsAccountId),
        savingsAccounts: Array.isArray(cleaned.savingsAccounts) ? cleaned.savingsAccounts.slice(0, 100) : [],
        activePayableId: toSafeId(cleaned.activePayableId),
        payables: Array.isArray(cleaned.payables) ? cleaned.payables.slice(0, 200) : [],
        activeReceivableId: toSafeId(cleaned.activeReceivableId),
        receivables: Array.isArray(cleaned.receivables) ? cleaned.receivables.slice(0, 200) : [],
        activeRemittanceId: toSafeId(cleaned.activeRemittanceId),
        remittances: Array.isArray(cleaned.remittances) ? cleaned.remittances.slice(0, 100) : [],
        creditCards: Array.isArray(cleaned.creditCards) ? cleaned.creditCards.slice(0, 100) : [],
        bills: Array.isArray(cleaned.bills) ? cleaned.bills.slice(0, 300) : [],
        billNotifications: {
          enabled: rawNotif.enabled !== false,
          dismissedToday:
            rawNotif.dismissedToday && typeof rawNotif.dismissedToday === 'object' ? rawNotif.dismissedToday : {},
          sentPushLog: rawNotif.sentPushLog && typeof rawNotif.sentPushLog === 'object' ? rawNotif.sentPushLog : {},
          deletedKeys: rawNotif.deletedKeys && typeof rawNotif.deletedKeys === 'object' ? rawNotif.deletedKeys : {},
          items: Array.isArray(rawNotif.items) ? rawNotif.items : [],
        },
        savedNames: {
          savings: Array.isArray(rawNames.savings) ? rawNames.savings : [],
          remittances: Array.isArray(rawNames.remittances) ? rawNames.remittances : [],
        },
      };

      this.lastPushedAt = nowMs;

      if (!this.hasCloudLedgerDoc) {
        const existingSnap = await getDocServerFirst(ledgerRef);
        this.hasCloudLedgerDoc = existingSnap.exists();
      }

      if (!this.hasCloudLedgerDoc) {
        await setDoc(ledgerRef, {
          ownerUid: uid,
          ...baseFields,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        this.hasCloudLedgerDoc = true;
      } else {
        await updateDoc(ledgerRef, {
          ...baseFields,
          updatedAt: serverTimestamp(),
        });
      }

      try {
        localStorage.setItem(LINKED_UID_KEY, uid);
        localStorage.removeItem(DIRTY_FLAG_KEY);
      } catch {
        /* ignore */
      }

      this.updateStatus({
        syncState: 'synced',
        lastSyncedAt: Date.now(),
        errorMessage: null,
      });
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : 'Cloud sync failed.';
      const isPerm = rawMsg.includes('Missing or insufficient permissions');
      const displayMsg = isPerm
        ? 'Firestore permission denied. Please verify that your latest firestore.rules are published in Firebase Console for the (default) database.'
        : rawMsg;
      this.updateStatus({
        syncState: 'error',
        errorMessage: displayMsg,
      });
      if (isPerm) {
        handleFirestoreError(error, OperationType.WRITE, ledgerPath);
      }
    }
  }

  private async handleAuthChanged(user: User | null): Promise<void> {
    if (this.unsubLedger) {
      this.unsubLedger();
      this.unsubLedger = null;
    }
    this.currentUser = user;
    this.hasCloudLedgerDoc = false;
    this.pendingConflictCloud = null;

    if (!user) {
      this.authInitPromise = null;
      this.updateStatus({
        ready: true,
        user: null,
        syncState: 'signed_out',
        lastSyncedAt: null,
        errorMessage: null,
        conflictSummary: null,
      });
      return;
    }

    const userInfo = this.toCloudUser(user);
    this.updateStatus({
      ready: true,
      user: userInfo,
      syncState: 'syncing',
      errorMessage: null,
    });

    if (!this.bridge) return;

    const runInit = async () => {
      try {
        await this.ensureUserProfileDoc(user);
        const ledgerPath = `users/${user.uid}/ledger/main`;
        const ledgerRef = doc(db, 'users', user.uid, 'ledger', 'main');
        const initialSnap = await getDocServerFirst(ledgerRef);
        const linkedUid = localStorage.getItem(LINKED_UID_KEY);
        const isDirty = localStorage.getItem(DIRTY_FLAG_KEY) === '1';
        const localState = this.bridge!.getLocalState();
        const localHasData = this.bridge!.hasMeaningfulData
          ? this.bridge!.hasMeaningfulData(localState)
          : countLedgerItems(localState) > 0;

        if (!initialSnap.exists()) {
          this.hasCloudLedgerDoc = false;
          await this.executePushNow(localState);
        } else {
          this.hasCloudLedgerDoc = true;
          const cloudData = initialSnap.data() as Record<string, unknown>;
          const cloudHasData = countLedgerItems(cloudData) > 0;
          const cloudClientUpdatedAt =
            typeof cloudData.clientUpdatedAt === 'number'
              ? cloudData.clientUpdatedAt
              : cloudData.updatedAt instanceof Timestamp
                ? cloudData.updatedAt.toMillis()
                : 0;

          if (linkedUid !== user.uid && localHasData && cloudHasData) {
            const localUpdatedAt = Number(localStorage.getItem(LOCAL_UPDATED_KEY) || 0) || Date.now();
            this.pendingConflictCloud = cloudData;
            this.pendingConflictCloudUpdatedAt = cloudClientUpdatedAt;
            this.updateStatus({
              syncState: 'conflict',
              conflictSummary: {
                localCount: countLedgerItems(localState),
                cloudCount: countLedgerItems(cloudData),
                localUpdatedAt,
                cloudUpdatedAt: cloudClientUpdatedAt,
              },
            });
          } else if (linkedUid === user.uid && isDirty) {
            await this.executePushNow(localState);
          } else if (!localHasData || cloudHasData) {
            const hydrated = await this.hydrateAttachments(user.uid, cloudData);
            this.applyRemoteStateSafely(hydrated);
            try {
              localStorage.setItem(LINKED_UID_KEY, user.uid);
              localStorage.removeItem(DIRTY_FLAG_KEY);
            } catch {
              /* ignore */
            }
            this.updateStatus({
              syncState: 'synced',
              lastSyncedAt: Date.now(),
              errorMessage: null,
            });
          } else {
            await this.executePushNow(localState);
          }
        }

        // Attach live Firestore listener
        const devId = getDeviceId();
        this.unsubLedger = onSnapshot(
          ledgerRef,
          async (snap) => {
            if (!snap.exists()) return;
            if (this.status.syncState === 'conflict') return;
            const remote = snap.data() as Record<string, unknown>;
            const remoteDev = typeof remote.deviceId === 'string' ? remote.deviceId : '';
            const remoteTs = typeof remote.clientUpdatedAt === 'number' ? remote.clientUpdatedAt : 0;
            if (remoteDev === devId && remoteTs <= this.lastPushedAt) {
              return;
            }
            const hydrated = await this.hydrateAttachments(user.uid, remote);
            this.applyRemoteStateSafely(hydrated);
            try {
              localStorage.setItem(LINKED_UID_KEY, user.uid);
              localStorage.removeItem(DIRTY_FLAG_KEY);
            } catch {
              /* ignore */
            }
            this.updateStatus({
              syncState: 'synced',
              lastSyncedAt: Date.now(),
              errorMessage: null,
            });
          },
          (error) => {
            this.updateStatus({
              syncState: 'error',
              errorMessage: error.message,
            });
            handleFirestoreError(error, OperationType.GET, ledgerPath);
          }
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unable to sync with Google Cloud.';
        this.updateStatus({
          syncState: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error',
          errorMessage: msg,
        });
      }
    };

    this.authInitPromise = runInit().finally(() => {
      this.authInitPromise = null;
    });
    await this.authInitPromise;
  }
}

declare global {
  interface Window {
    TalaCloudSync?: TalaCloudSyncManager;
  }
}

const syncManager = new TalaCloudSyncManager();
window.TalaCloudSync = syncManager;
if (typeof window !== 'undefined') {
  window.dispatchEvent(new CustomEvent('tala-cloud-sync-ready'));
}
export default syncManager;
