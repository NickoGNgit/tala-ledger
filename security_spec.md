# Tala Ledger Firestore Security Specification

## 1. Data Invariants
1. A `/users/{userId}` document can only be read, created, updated, or deleted by the authenticated, email-verified user whose `request.auth.uid == userId` and `incoming().uid == userId`.
2. Directory listing (`list`) on `/users` is strictly denied (`allow list: if false`) to prevent user enumeration or PII exposure.
3. Subcollection documents under `/users/{userId}/ledger/{ledgerId}` (only `ledgerId == 'main'`) and `/users/{userId}/attachments/{attachmentId}` enforce the Master Gate: the parent `/users/{userId}` document must exist and have `uid == request.auth.uid`.
4. `ownerUid`, `uid`, `attachmentId`, and `createdAt` are immutable after document creation.
5. `createdAt` and `updatedAt` must always equal server `request.time`.
6. Every string, list, and map has explicit type and size constraints; attachment `dataUrl` must start with `data:image/` and stay below 900,000 bytes.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: `request.auth == null` targeting `/users/u1/ledger/main` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoofing**: `request.auth.uid == 'u1'` with `token.email_verified == false` -> `PERMISSION_DENIED`.
3. **Cross-Tenant Read**: `request.auth.uid == 'u2'` reading `/users/u1` or `/users/u1/ledger/main` -> `PERMISSION_DENIED`.
4. **User Directory Enumeration**: `list` query on `/users` by signed-in user -> `PERMISSION_DENIED`.
5. **Identity Spoofing on Create**: `request.auth.uid == 'u1'` creating `/users/u1/ledger/main` with `ownerUid: 'u2'` -> `PERMISSION_DENIED`.
6. **Shadow Field Injection (Ghost Field)**: Creating or updating `/users/u1` with `{ ..., isAdmin: true }` -> `PERMISSION_DENIED` (`keys().hasOnly(...)` / `affectedKeys().hasOnly(...)`).
7. **Orphaned Subcollection Write**: Creating `/users/u1/ledger/main` before `/users/u1` exists -> `PERMISSION_DENIED` (Master Gate `get()`).
8. **Invalid Ledger Document ID**: Writing `/users/u1/ledger/backup_1` instead of `main` -> `PERMISSION_DENIED`.
9. **ID Poisoning (Oversized / Malformed Path ID)**: Writing `/users/u1/attachments/bad$id_...150chars` -> `PERMISSION_DENIED` (`isValidId()`).
10. **Immutable Field Tampering**: Updating `/users/u1/ledger/main` and changing `createdAt` or `ownerUid` -> `PERMISSION_DENIED`.
11. **Client-Forged Timestamp**: Creating `/users/u1/ledger/main` with `createdAt: new Date(0)` instead of `request.time` -> `PERMISSION_DENIED`.
12. **Value Poisoning / XSS Payload in Attachment**: Creating `/users/u1/attachments/att_1` with `dataUrl: "javascript:alert(1)"` or >900KB string -> `PERMISSION_DENIED`.
