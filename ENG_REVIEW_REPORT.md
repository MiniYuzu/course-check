# Engineering Review Report: 课程打卡小程序

**Review Date:** 2026-04-09  
**Reviewers:** Claude Code /plan-eng-review  
**Status:** DRAFT - Pre-implementation  
**Scope:** Design documents review (mini-main-design-20260409-092429.md, DESIGN.md)

---

## Executive Summary

This review evaluates the technical design of a WeChat Mini Program for tracking child's course attendance. The design shows solid product thinking and good UI/UX planning, but has significant gaps in technical implementation details, error handling, and security specifications.

**Overall Score: 5.5/10** — Ready for MVP implementation with critical gaps addressed.

---

## Step 0: Scope Challenge

### Minimal Viable Version Recommendation

**Original Plan:** 4-phase implementation over 8+ days  
**Recommended:** Complete Phase 1 only, but make it production-ready

**Phase 1 MVP (Complete Before Expanding):**
- Create course (name + icon)
- One-tap check-in (date only)
- View course list with count
- Cloud persistence
- Offline queue + sync
- Basic error handling

**Deferred:**
- Detailed check-in forms → Phase 2
- Photo upload → Phase 2
- Family sharing → Phase 3
- Reminders/notifications → Phase 3
- Charts/statistics → Phase 3

**Rationale:** The developer has no mini program experience. A complete, robust MVP is more valuable than a fragile full-featured app.

---

## Step 1: Threat Modeling

### Critical Security Gaps

| Threat | Risk Level | Current State | Required Action |
|--------|------------|---------------|-----------------|
| **Data Access Control** | HIGH | Members array defined, no security rules | Document CloudBase security rules before implementation |
| **Photo Upload Abuse** | MEDIUM | No validation specified | Add file type/size validation |
| **Check-in Spoofing** | MEDIUM | Client-side dates | Use server timestamp, validate date range |
| **Invite Link Abuse** | MEDIUM | No expiration mechanism | Add 24h expiration, usage limits |

### Required Security Rules (CloudBase)

```javascript
// courses collection
{
  "read": "auth.openid == doc.createdBy || doc.members.includes(auth.openid)",
  "write": "auth.openid == doc.createdBy"
}

// checkins collection
{
  "read": "get(/databases/$(database)/documents/courses/$(doc.courseId)).data.members.includes(auth.openid)",
  "write": "get(/databases/$(database)/documents/courses/$(doc.courseId)).data.members.includes(auth.openid)"
}

// user_settings collection
{
  "read": "auth.openid == doc.userId",
  "write": "auth.openid == doc.userId"
}
```

---

## Step 2: Error Handling Taxonomy

### Error Paths Matrix

| Component | Error Scenario | Handling Strategy | Priority |
|-----------|----------------|-------------------|----------|
| db.js | CloudBase init failure | Fallback to local-only, warn user | CRITICAL |
| db.js | Network timeout on read | Retry 3x with backoff, show cached | CRITICAL |
| db.js | Network timeout on write | Queue for sync, show "saved locally" | CRITICAL |
| db.js | Permission denied | Clear message, suggest re-auth | HIGH |
| checkin | Duplicate same day | Prevent, show "already checked in" | HIGH |
| checkin | Invalid courseId | Validate before write | HIGH |
| cloud fn | Cold start timeout | Show skeleton, retry | MEDIUM |
| storage | Photo upload fail | Retry once, fallback to no photo | MEDIUM |

### Missing Error Handling (Critical)

1. **No offline queue specification** — Violates "data can't be lost" premise
2. **No retry logic** — Network flakiness will cause failures
3. **No global error boundary** — Silent crashes possible
4. **No input validation schema** — Malformed data could break queries

### Recommended Error Handler API

```javascript
// error-handler.js specification
const ErrorHandler = {
  // User-facing errors
  showUserError(message, options),
  showNetworkError(retryCallback),
  showSuccess(message),
  
  // Internal handling
  logError(context, error),
  reportToMonitoring(error),
  
  // Recovery
  queueForSync(operation),
  processSyncQueue()
};
```

---

## Step 3: Data Flow Tracing

### Check-in Data Flow

```
User Tap
    │
    ▼
┌─────────────┐
│ UI validates│── Duplicate check? ──▶ Error: Already checked in
│ (not dup)   │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌─────────────┐
│  db.add()   │────▶│ CloudBase   │
│  (client)   │     │  Database   │
└──────┬──────┘     └──────┬──────┘
       │                   │
       │              ┌────┴────┐
       │              ▼         ▼
       │           Success   Failure
       │              │         │
       │              ▼         ▼
       │         Update cache  Queue
       │              │       for retry
       │              ▼         │
       └──────────▶ Show success ◀───┘
```

### Race Condition Risks

1. **Duplicate check-ins**: Two family members tapping simultaneously
   - **Mitigation**: Use unique index on (courseId, date) in CloudBase

2. **Partial writes**: Check-in created but photo upload fails
   - **Mitigation**: Transaction pattern or cleanup job

3. **Cache inconsistency**: Local shows success, cloud write failed
   - **Mitigation**: Confirm cloud write before UI success state

---

## Step 4: Dependency Risk Analysis

### WeChat CloudBase Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Cold start latency (2-3s) | HIGH | MEDIUM | Show loading skeleton, cache data |
| Free tier limits exceeded | LOW | HIGH | Monitor at 80%, alert user |
| Service downtime | LOW | CRITICAL | Local cache + offline queue |
| API breaking changes | MEDIUM | MEDIUM | Pin SDK versions |
| Vendor lock-in | CERTAIN | MEDIUM | Document export path |
| WeChat policy changes | LOW | CRITICAL | Keep backup export ready |

### SDK Recommendations

**Start with:**
- WeUI (official, lightweight)
- Native wx.cloud API

**Consider later:**
- Vant Weapp (richer components, +200KB)

---

## Step 5: Implementation Complexity

### Complexity by Component

| Component | Complexity | Risk | Notes |
|-----------|------------|------|-------|
| Course CRUD | Low | Low | Standard operations |
| Simple check-in | Medium | Medium | Duplicate prevention needed |
| Offline sync queue | HIGH | HIGH | Cache invalidation complexity |
| Photo upload | Medium | Medium | Progress handling, failures |
| Family sharing | HIGH | HIGH | Permission model, invites |
| Statistics | Medium | Medium | Aggregation strategy |

### Key Complexity Concerns

1. **Client-side aggregation**: Design specifies this for statistics
   - **Risk**: N+1 queries as data grows
   - **Better**: CloudBase aggregation pipeline or pre-computed counters

2. **Equal access permission model**: "All members equal in MVP"
   - **Risk**: No audit trail
   - **Mitigation**: At minimum, add `createdBy` to checkin records

---

## Step 6: Testability Assessment

### Testing Strategy for Mini Programs

**Unit Tests (Jest):**
- db.js methods
- Utility functions
- Data transformations

**Integration Tests:**
- Cloud function calls
- Database operations
- Sync queue behavior

**Manual QA (Required):**
- UI flows (mini program testing tools are limited)
- Device-specific behavior
- Network condition variations

### Critical Test Cases

| Test | Priority |
|------|----------|
| Check-in creates correct document | CRITICAL |
| Duplicate check-in prevention | CRITICAL |
| Offline queue syncs on reconnect | CRITICAL |
| Family member can read shared course | HIGH |
| Photo upload + check-in atomicity | MEDIUM |
| Statistics calculation accuracy | HIGH |

---

## Step 7: Observability Requirements

### Logging Strategy

```javascript
// Key events to log
const EVENTS = {
  CHECKIN_SUCCESS: 'checkin_success',
  CHECKIN_FAILURE: 'checkin_failure',
  SYNC_QUEUE_STATUS: 'sync_queue_status',
  AUTH_STATE_CHANGE: 'auth_state_change',
  PHOTO_UPLOAD_SUCCESS: 'photo_upload_success',
  PHOTO_UPLOAD_FAILURE: 'photo_upload_failure',
  FAMILY_SHARE_INVITE_ACCEPTED: 'family_share_invite_accepted'
};
```

### Metrics to Track

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Check-in latency | < 3s | > 5s |
| Cloud function cold start | < 3s | > 5s |
| Sync queue depth | 0 | > 10 items |
| Error rate | < 1% | > 5% |

---

## Step 8: ASCII Diagrams Verification

### Existing Diagrams (Good)
- Course card layout
- Toast/modal designs
- Error state screens

### Missing Diagrams (Add These)

**Data Model Relationships:**
```
courses ──1:N──▶ checkins
users ──1:1──▶ user_settings
courses ──N:M──▶ users (members)
```

**Sync Queue State Machine:**
```
[Pending] ──▶ [Syncing] ──▶ [Synced]
                 │
                 ▼
              [Failed] ──▶ [Retry with backoff]
```

---

## Step 9: Documentation Completeness

### Well Documented
- Design philosophy and principles
- UI/UX specifications
- Color system and spacing
- Page structure
- Data models (schema)

### Critical Gaps

| Gap | Impact | Action Required |
|-----|--------|-----------------|
| db.js API contract | High dev friction | Document all methods, inputs, outputs |
| Error handling patterns | Bugs in production | Specify error-handler.js API |
| Database security rules | Security vulnerability | Write rules before coding |
| Cloud function specs | Unclear implementation | Document triggers, inputs, outputs |
| Testing strategy | Quality risk | Define test approach |
| Deployment checklist | Launch risk | Create step-by-step checklist |

---

## Step 10: Final Verdict

### Scoring

| Category | Score | Notes |
|----------|-------|-------|
| Architecture | 7/10 | CloudBase is appropriate, good separation |
| Security | 5/10 | Missing security rules, needs hardening |
| Error Handling | 4/10 | Insufficient detail for production |
| Testability | 5/10 | Mini program testing is challenging |
| Observability | 3/10 | No logging/metrics plan |
| Documentation | 6/10 | Good UI docs, thin technical specs |
| **Overall** | **5.5/10** | **Address critical gaps before implementation** |

### Critical Issues (Block Implementation)

1. **Database Security Rules** — Define before any code is written
2. **Offline Sync Strategy** — Document queue implementation
3. **Error Handler Specification** — Define API and patterns
4. **Duplicate Prevention** — Unique constraint strategy

### Recommendations

1. **Reduce initial scope**: Complete Phase 1 only, but make it robust
2. **Add technical specifications**: Document db.js, error-handler.js APIs
3. **Define security rules**: Before writing cloud functions
4. **Create test plan**: Document what needs testing
5. **Add basic observability**: Logging from day one

### Action Items

| Priority | Item | Owner |
|----------|------|-------|
| P0 | Write CloudBase security rules | Developer |
| P0 | Specify db.js API contract | Developer |
| P0 | Design offline sync queue | Developer |
| P1 | Create error-handler.js spec | Developer |
| P1 | Define test strategy | Developer |
| P2 | Add data export/backup plan | Developer |
| P2 | Document deployment process | Developer |

---

## Appendix: Technical Decisions Evaluation

### Decision: WeChat Mini Program + CloudBase
**Verdict:** APPROVED  
**Rationale:** Zero server cost, fits user habits, good for first-time developer

### Decision: 3 Collections (courses, checkins, user_settings)
**Verdict:** APPROVED  
**Rationale:** Clean separation, scalable

### Decision: Simple Permission Model (equal access)
**Verdict:** CONDITIONAL  
**Rationale:** OK for MVP, but add `createdBy` audit field and plan for role-based access in future

### Decision: Client-side Aggregation
**Verdict:** CONCERN  
**Rationale:** Will cause N+1 queries at scale. Consider CloudBase aggregation or pre-computed counters.

### Decision: Local Cache for Offline
**Verdict:** APPROVED  
**Rationale:** Critical for "data can't be lost" premise, but needs careful implementation

### Decision: db.js Encapsulation Layer
**Verdict:** APPROVED  
**Rationale:** Good abstraction, enables testing and future backend swaps

---

*Report generated by Claude Code /plan-eng-review*  
*For course-check mini program project*
