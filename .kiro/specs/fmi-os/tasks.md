# Implementation Plan: FMI OS

## Overview

Incremental build of the FMI OS desktop learning environment: AWS Amplify project scaffold → auth → boot animation → desktop UI shell with 6 apps → hierarchical Materials folder system + Bedrock KB → Gus multi-source Q&A → Timetable OCR → learning session with 80/20 prioritization → progress tracking → Roadmap generation. Property-based tests with `fast-check` are woven in alongside each feature to validate correctness properties as code is written.

---

## Tasks

- [x] 1. Initialize AWS Amplify project and authentication
  - [x] 1.1 Scaffold React/TypeScript Amplify app and configure Amplify CLI
    - Run `create-react-app` with TypeScript template, then `amplify init` targeting the workspace.
    - Add `aws-amplify`, `@aws-amplify/ui-react`, `graphql`, `fast-check`, `jest`, `react-testing-library`, `lottie-react` and configure `tsconfig.json`.
    - _Requirements: 1.1, 2.1_

  - [x] 1.2 Add Cognito Auth resource with university email validation
    - `amplify add auth` with email sign-up, custom lambda pre-sign-up trigger that validates `@s.unibuc.ro` domain and rejects other addresses.
    - Configure JWT token validity (1 hour access token, 30 day refresh token); implement silent refresh logic.
    - _Requirements: 1.1, 1.2_

  - [x] 1.3 Implement registration and login pages with validation
    - `RegisterPage`: form with email + password fields; client-side regex check for `@s.unibuc.ro`; calls `Auth.signUp`.
    - `LoginPage`: calls `Auth.signIn`; on any auth error, display generic message "Email or password is incorrect."
    - _Requirements: 1.1, 1.3_

  - [x] 1.4 Write property test for generic authentication error messages (Property 1)
    - **Property 1: Generic Authentication Error Messages**
    - Generate arbitrary (email, password) pairs; stub Cognito error variants; assert UI error string is identical regardless of which field caused failure.
    - **Validates: Requirements 1.3**

  - [x] 1.5 Implement session token expiry handling with route restoration
    - In Amplify Auth hub listener, catch `tokenRefresh_failure`; save `window.location.pathname` to `sessionStorage`; redirect to `/login`; restore on next successful sign-in.
    - _Requirements: 1.4_

  - [x] 1.6 Add AppSync GraphQL API with core schema
    - `amplify add api` (GraphQL), define schema with `Student`, `FolderNode`, `MaterialFile`, `Examination`, `TimeBlock`, `GradeRecord`, `WeakPoint`, `LearningGoal`, `TopicProgress`, `Session` models.
    - Attach `@auth(rules: [{ allow: owner }])` on all models; verify Cognito authorizer is wired.
    - _Requirements: 1.5, 7.1_

  - [x] 1.7 Add Amplify Storage (S3) with per-student prefix IAM policy
    - `amplify add storage` scoped to `students/{cognito:sub}/*`.
    - Verify IAM condition key policy prevents cross-student S3 access.
    - _Requirements: 1.5, 7.3_

  - [x] 1.8 Write property test for student data isolation (Property 2)
    - **Property 2: Student Data Isolation**
    - Generate random pairs of distinct student IDs; stub AppSync queries; assert no query authenticated as studentA returns data with `studentId: studentB`.
    - **Validates: Requirements 1.5**

- [ ] 2. Boot Animation and Desktop Environment shell
  - [x] 2.1 Implement BootAnimation component with Lottie
    - Display Lottie animation (or CSS keyframes fallback) on initial authentication; duration target <5 seconds.
    - Implement skip on any user interaction (keydown, click, touch); fade-out transition to Desktop.
    - _Requirements: 2.1, 2.2_

  - [x] 2.2 Write property test for boot animation skippability (Property 3)
    - **Property 3: Boot Animation Skippability**
    - Generate random user input events (key press, mouse click); assert animation terminates immediately and transitions to Desktop Environment.
    - **Validates: Requirements 2.3**

  - [x] 2.3 Implement DesktopEnvironment layout component
    - Full-viewport `div` (100vw × 100vh) with `overflow: hidden`.
    - Render 6 desktop app icons: Materials, Future Examinations, Calendar, Timetable, Stats, Roadmap.
    - Maintain `WindowState[]` in React state for panel registry; expose `openPanel`, `closePanel`, `focusPanel` context.
    - _Requirements: 3.1, 3.2_

  - [x] 2.4 Implement WindowPanel draggable container component
    - Render title bar with drag handle and close button; track position via mouse events.
    - On focus, raise `zIndex` above all other panels via panel registry context.
    - Support multiple simultaneous open windows with independent state.
    - _Requirements: 3.2, 3.3, 3.4_

  - [x] 2.5 Write property test for desktop window management independence (Property 4)
    - **Property 4: Desktop Window Management Independence**
    - Generate arbitrary sets of open windows with random positions/sizes; modify one window's properties; assert no other window's state changes.
    - **Validates: Requirements 3.3**

  - [x] 2.6 Implement desktop state persistence to localStorage/DynamoDB
    - Serialize `WindowState[]` on state changes; restore on page load or re-authentication.
    - Persist window positions, sizes, open/closed state, focused app.
    - _Requirements: 3.5_

  - [x] 2.7 Write property test for state persistence round-trip (Property 5)
    - **Property 5: State Persistence Round-Trip**
    - Generate random desktop states; persist and restore; assert restored state matches original (window positions, sizes, open apps, focus).
    - **Validates: Requirements 3.5**

  - [-] 2.8 Write property test for responsive layout invariant (Property 6)
    - **Property 6: Responsive Layout Invariant**
    - Generate viewport widths in [1024, 3840]; render DesktopEnvironment; assert no horizontal overflow and all UI elements visible.
    - **Validates: Requirements 3.6**

  - [~] 2.9 Checkpoint — verify desktop shell and boot sequence
    - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Taskbar with voice commands and Account Center
  - [x] 3.1 Implement Taskbar component with three controls
    - Fixed bottom bar always visible when authenticated.
    - Render "Start today's session" button, "Ask Gus" text input + microphone icon, Account Center icon.
    - _Requirements: 4.1, 4.2_

  - [-] 3.2 Write property test for Taskbar persistent visibility (Property 7)
    - **Property 7: Taskbar Persistent Visibility**
    - Generate arbitrary desktop states (open panels, routes); render; assert Taskbar and all three controls are present and actionable.
    - **Validates: Requirements 4.1**

  - [~] 3.3 Implement VoiceCommandHandler with Web Speech API
    - Activate on microphone icon click; transcribe speech to text using `SpeechRecognition` API.
    - Populate "Ask Gus" input with transcription, or trigger session start if phrase matches "Start today's session".
    - Provide visual feedback (animated mic icon) while listening; disable mic icon with tooltip if API unavailable.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [~] 3.4 Write property test for voice transcription accuracy propagation (Property 27)
    - **Property 27: Voice Transcription Accuracy Propagation**
    - Generate random transcription strings; mock Web Speech API; assert input field receives exact transcription with no modifications.
    - **Validates: Requirements 5.2**

  - [~] 3.5 Implement AccountCenter panel component
    - Display student email (read-only), display name (editable), API key management section (view/regenerate/delete).
    - Provide logout button; close on outside click or Escape key.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [~] 3.6 Write property test for Account Center close triggers (Property 26)
    - **Property 26: Account Center Close Triggers**
    - Generate open Account Center states; simulate outside click and Escape key; assert both triggers independently close panel.
    - **Validates: Requirements 6.5**

- [ ] 4. Hierarchical Materials App and Knowledge Base
  - [x] 4.1 Implement folder hierarchy storage schema in DynamoDB
    - Define `FolderNode` adjacency list model: `{id, studentId, name, parentId, path, createdDate}`.
    - Implement queries: create folder, list children, move folder (update `path` recursively), delete folder (recursive).
    - _Requirements: 7.1, 7.2_

  - [x] 4.2 Implement MaterialsApp tree view component
    - Display hierarchical folder/file tree with expand/collapse; root folder representing entire KB.
    - Context menu for folder operations: create child folder, rename, move, delete.
    - _Requirements: 7.1, 7.2_

  - [x] 4.3 Implement file upload validation utility
    - Export `validateUpload(file: File): { valid: boolean; error?: string }`.
    - Accept iff extension ∈ `{pdf, pptx, txt, md, docx, xlsx, png, jpg, jpeg}` AND `file.size ≤ 20 * 1024 * 1024`.
    - _Requirements: 7.4, 7.5_

  - [x] 4.4 Write property test for file format and size validation (Property 8)
    - **Property 8: File Format and Size Validation**
    - Generate random file objects with varying extensions and sizes; assert `validateUpload` returns `valid === true` iff format allowed AND size ≤ 20MB.
    - **Validates: Requirements 7.4, 7.5**

  - [x] 4.5 Implement file upload to hierarchical folders with S3
    - Drag-and-drop zone + file picker in MaterialsApp; validate via `validateUpload`.
    - Upload to S3 at `students/{userId}/materials/{folderPath}/{fileName}`; store `MaterialFile` record in DynamoDB with `folderPath`.
    - Show per-file progress bar and indexing status indicator (Pending, Indexing, Indexed, Failed).
    - _Requirements: 7.3, 7.4, 7.5, 7.7_

  - [-] 4.6 Implement materialIndexTrigger Lambda (S3 event)
    - Trigger on `s3:ObjectCreated:*` under `students/{userId}/materials/`.
    - Start Bedrock Knowledge Base sync job with metadata tags `{studentId, folderPath}`.
    - Write `INDEXING` status to DynamoDB `MaterialFile`; update to `INDEXED` or `FAILED` on completion.
    - _Requirements: 7.6_

  - [~] 4.7 Write property test for materials tree view correctness (Property 10)
    - **Property 10: Materials Tree View Correctness**
    - Generate random folder/file structures in DynamoDB; render MaterialsApp tree; assert every stored node appears exactly once and no extra nodes appear.
    - **Validates: Requirements 7.1**

  - [~] 4.8 Write property test for hierarchical folder operations (Property 11)
    - **Property 11: Hierarchical Folder Operations**
    - Generate folder hierarchies; perform operations (create child, move, delete); assert descendants are correctly updated (e.g., delete propagates recursively).
    - **Validates: Requirements 7.2, 7.3, 7.8**

  - [~] 4.9 Implement folder path citation metadata in Bedrock KB
    - Ensure all ingested chunks tagged with `{studentId, folderPath}` metadata.
    - Configure retrieval filter: `{ equals: { key: "studentId", value: studentId } }` on all queries.
    - _Requirements: 7.9, 14.4_

  - [~] 4.10 Write property test for folder hierarchy citation preservation (Property 9)
    - **Property 9: Folder Hierarchy Citation Preservation**
    - Generate files at various folder paths; mock Gus citations; assert every citation includes full folder path (e.g., "Data Structures > Week 3 > file.pdf").
    - **Validates: Requirements 7.9, 14.4**

- [~] 5. Checkpoint — Materials hierarchy and upload pipeline
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Future Examinations App
  - [x] 6.1 Implement Examination DynamoDB model and queries
    - Define `Examination` model: `{id, studentId, examName, subject, date, notes}`.
    - Implement mutations: add, edit, delete examination; query all examinations for student.
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 6.2 Implement FutureExaminationsApp timeline view
    - Display examinations in chronological order by date.
    - Visual urgency indicator (color/icon) for exams ≤ 7 days away.
    - Add/edit/delete controls for examination entries.
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

  - [~] 6.3 Write property test for exam timeline chronological ordering (Property 12)
    - **Property 12: Exam Timeline Chronological Ordering**
    - Generate random examination sets; render timeline; assert exams appear in strictly chronological order by date.
    - **Validates: Requirements 9.1**

  - [~] 6.4 Write property test for exam urgency highlighting (Property 13)
    - **Property 13: Exam Urgency Highlighting**
    - Generate examinations with various dates; assert exams with (date - today) ≤ 7 days display urgency indicator.
    - **Validates: Requirements 9.5**

- [ ] 7. Calendar App — external integration
  - [~] 7.1 Implement CalendarApp with dual integration mode
    - **API mode**: OAuth with external provider (Google Calendar/Outlook); fetch events via API; display in calendar widget.
    - **Iframe mode**: Embed external calendar webpage if API unavailable.
    - Auto-refresh every 15 minutes while window open; error handling with retry button.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ] 8. Timetable App — OCR extraction and manual editing
  - [~] 8.1 Implement TimeBlock DynamoDB model
    - Define `TimeBlock` model: `{id, studentId, day, startTime, endTime, className, location}`.
    - Implement mutations: add, edit, delete time block; query all blocks for student.
    - _Requirements: 11.1, 11.4_

  - [~] 8.2 Implement timetableOcrHandler Lambda
    - Accept uploaded timetable image (PNG, JPG, PDF); invoke Amazon Textract `AnalyzeDocument` or Bedrock Vision.
    - Parse OCR output to extract class names, days, time ranges; structure into `TimeBlock[]`.
    - Persist extracted blocks to DynamoDB.
    - _Requirements: 11.2, 11.3_

  - [~] 8.3 Implement TimetableApp component with OCR upload and editable grid
    - Upload image via drag-and-drop or file picker; trigger `timetableOcrHandler`.
    - Display extracted timetable in weekly grid format (days as columns, time slots as rows).
    - Allow manual add, edit, delete of time blocks; persist all changes to DynamoDB.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6_

- [ ] 9. Stats App — grades and weak points
  - [~] 9.1 Implement GradeRecord and WeakPoint DynamoDB models
    - Define `GradeRecord`: `{id, studentId, subject, examOrTopic, grade, notes, date}`.
    - Define `WeakPoint`: `{id, studentId, topicOrSubject, severity, notes, flaggedDate}`.
    - Implement mutations for add/edit/delete both record types.
    - _Requirements: 12.1, 12.2_

  - [~] 9.2 Implement StatsApp component with grade entry and weak point marking
    - Display summary view of all recorded grades and weak points organized by subject/topic.
    - Forms for adding grades/notes; controls for marking topics as weak points (checkbox, rating scale).
    - _Requirements: 12.1, 12.2, 12.3, 12.5_

- [~] 10. Checkpoint — All 6 desktop apps functional
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Gus AI Agent — multi-source Q&A
  - [~] 11.1 Implement ragOrchestrator Lambda with multi-source context
    - Accept `GusQueryInput`: `{studentId, sessionId, message, conversationHistory}`.
    - Query all context sources in parallel:
      - Materials KB retrieval with `{studentId}` filter (top 20 chunks, ~40k tokens)
      - Progress Profile from DynamoDB (~5k tokens)
      - Future Examinations (deadlines ≤ 14 days, ~2k tokens)
      - Timetable (all time blocks, ~2k tokens)
      - Stats weak points (~1k tokens)
    - Build system prompt injecting all context; call Bedrock Claude `InvokeModel` with conversation history.
    - Parse response; extract citations with folder paths from KB metadata; return `GusQueryOutput`.
    - _Requirements: 14.1, 14.2, 14.4, 14.5_

  - [~] 11.2 Implement empty Knowledge Base guard
    - Before retrieval, check if student has any indexed materials; if not, return templated message without calling Bedrock.
    - _Requirements: 14.3_

  - [~] 11.3 Implement GusChatPanel component
    - Render conversation as message list; submit triggers `askGus` mutation.
    - Stream partial response tokens as they arrive; render citations as expandable source links with folder paths.
    - Show retry button on error; maintain conversational context.
    - _Requirements: 14.2, 14.4, 14.5, 14.6_

  - [~] 11.4 Write property test for Gus multi-source context inclusion (Property 15)
    - **Property 15: Gus Multi-Source Context Inclusion**
    - Generate students with non-empty Materials, Examinations, Timetable, Stats; mock context queries; assert all five sources are queried and included.
    - **Validates: Requirements 14.1, 15.1**

  - [~] 11.5 Write property test for conversational context preservation (Property 16)
    - **Property 16: Conversational Context Preservation**
    - Generate multi-turn conversation sequences with entity references in earlier turns; assert conversation history passed to Claude contains all prior turns in order.
    - **Validates: Requirements 14.5**

  - [~] 11.6 Implement fileSearchHandler Lambda for Gus resource search
    - Accept `FileSearchInput`: `{studentId, query}` (natural language, e.g., "Find my data structures notes from week 3").
    - Query DynamoDB folder structure + file metadata; use semantic search (Bedrock KB metadata query) or keyword matching.
    - Rank results by relevance score; return list with folder paths.
    - _Requirements: 8.1, 8.2_

  - [~] 11.7 Implement file search result navigation in GusChatPanel
    - Render search results with folder paths and file names; provide direct links.
    - Clicking result opens MaterialsApp and expands folder tree to reveal selected file.
    - _Requirements: 8.3, 8.4_

  - [~] 11.8 Write property test for file search result navigation correctness (Property 29)
    - **Property 29: File Search Result Navigation Correctness**
    - Generate file search results; simulate click; assert MaterialsApp opens and correct file is highlighted at correct path.
    - **Validates: Requirements 8.3**

- [ ] 12. 80/20 Learning Session with multi-source prioritization
  - [~] 12.1 Implement topic prioritization scoring utility
    - Export `calculateTopicScore(topic, progress, examinations, weakPoints): number`.
    - Scoring formula: `comprehensionScore + recencyScore + urgencyScore + weakPointScore`.
    - Higher score = higher priority (lower comprehension, older last-studied date, exam urgency, weak point flag).
    - _Requirements: 15.2, 16.3_

  - [~] 12.2 Write property test for weak point prioritization (Property 18)
    - **Property 18: Weak Point Prioritization**
    - Generate topics with some marked as weak points; score topics; assert weak point topics rank higher than non-weak with equivalent other factors.
    - **Validates: Requirements 12.4, 15.2**

  - [~] 12.3 Write property test for exam urgency prioritization (Property 19)
    - **Property 19: Exam Urgency Prioritization**
    - Generate topics related to exams with deadlines ≤ 14 days; score topics; assert urgent topics rank higher than non-urgent with equivalent other factors.
    - **Validates: Requirements 9.4, 15.2**

  - [~] 12.4 Write property test for low comprehension prioritization (Property 23)
    - **Property 23: Low Comprehension Prioritization**
    - Generate topics with varying comprehension levels; score topics; assert lower comprehension ranks higher, and among equals, older last-studied dates rank higher.
    - **Validates: Requirements 16.3**

  - [~] 12.5 Implement sessionGenerator Lambda
    - Accept `SessionGeneratorInput`: `{studentId}`.
    - Query DynamoDB: Progress Profile, Future Examinations (≤ 14 days), Stats weak points, Timetable.
    - Query Bedrock KB for all available topics (filtered by studentId).
    - Score all topics using `calculateTopicScore`; select top N where N = ⌈0.20 × total_topics⌉, minimum 1.
    - For each selected topic, call Claude to generate summary, key points, comprehension question from Materials chunks.
    - Persist session plan to DynamoDB `sessions` table with status `IN_PROGRESS`; return `SessionGeneratorOutput`.
    - _Requirements: 15.1, 15.2, 15.3_

  - [~] 12.6 Write property test for 20% topic cap in learning sessions (Property 17)
    - **Property 17: 20% Topic Cap in Learning Sessions**
    - Generate topic arrays of varying sizes (1-100); generate session plan; assert selected topics ≤ ⌈0.20 × N⌉ && ≥ 1, each with title, duration, summary, key points, comprehension question.
    - **Validates: Requirements 15.2, 15.3**

  - [~] 12.7 Write property test for timetable conflict avoidance (Property 14)
    - **Property 14: Timetable Conflict Avoidance**
    - Generate session plans and timetables with various time blocks; assert no recommended study time overlaps with any class time.
    - **Validates: Requirements 11.5, 15.7**

  - [~] 12.8 Implement LearningSessionPanel component — plan preview step
    - On mount, query most recent `IN_PROGRESS` session or call `startSession` mutation.
    - Render plan preview: list selected topics with titles, estimated minutes, prioritization rationale; "Begin Session" button advances to first topic.
    - _Requirements: 15.3_

  - [~] 12.9 Implement LearningSessionPanel — topic guide and comprehension check
    - Step through `SessionTopic[]` sequentially; render summary, key points for each topic.
    - Display comprehension question as text input or MCQ; on answer submission, call `updateProgress` mutation.
    - Advance to next topic or completion summary.
    - _Requirements: 15.4, 15.5_

  - [~] 12.10 Implement session exit/resume logic
    - On panel close mid-session, call `updateProgress` with current `lastCompletedTopicIndex`; set session status to `IN_PROGRESS`.
    - On next mount, detect existing `IN_PROGRESS` session and restore to `lastCompletedTopicIndex + 1`.
    - _Requirements: 15.6_

  - [~] 12.11 Write property test for session resume correctness (Property 20)
    - **Property 20: Session Resume Correctness**
    - Generate sessions with random K completed topics; simulate exit + resume; assert resume starts at topic K+1 and topics 0..K are marked complete with recorded comprehension.
    - **Validates: Requirements 15.6**

- [~] 13. Checkpoint — Learning session flow passes end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Progress Tracking
  - [~] 14.1 Implement TopicProgress DynamoDB model
    - Define `TopicProgress`: `{id, studentId, topicId, topicTitle, lastStudiedDate, comprehensionLevel, sessionCount, manualOverride}`.
    - Implement queries: list all progress for student, get progress for specific topic.
    - _Requirements: 16.1_

  - [~] 14.2 Implement progressUpdater Lambda
    - Accept `ProgressUpdateInput`: `{studentId, topicId, updateType, comprehensionLevel, sessionId}`.
    - On `comprehension-check` type, update `TopicProgress` record with new level and `lastStudiedDate`.
    - On `manual-override` type, set `manualOverride: true` flag.
    - _Requirements: 15.5, 16.2_

  - [~] 14.3 Write property test for comprehension check progress update (Property 21)
    - **Property 21: Comprehension Check Progress Update**
    - Generate random comprehension check results; call `updateProgress`; query topic progress; assert comprehension level matches submitted result and update is durable.
    - **Validates: Requirements 15.5, 16.2**

  - [~] 14.4 Write property test for progress profile completeness (Property 22)
    - **Property 22: Progress Profile Completeness**
    - Generate Progress Profiles; assert every topic record includes all required fields: topicId, topicTitle, lastStudiedDate (or null), comprehensionLevel, sessionCount.
    - **Validates: Requirements 16.1**

  - [~] 14.5 Implement ProgressPanel component (optional, for Stats app integration)
    - Query `listTopicProgress` (owner-scoped); render each topic as card showing title, comprehension level indicator, last-studied date.
    - Add "Mark as understood" and "Needs review" buttons per card; call `updateProgress` with `manual-override` type.
    - _Requirements: 16.4_

  - [~] 14.6 Surface low-comprehension topics in session generator
    - In `sessionGenerator`, ensure topics flagged with `manualOverride: true` and low comprehension are included in candidate pool and scored appropriately.
    - _Requirements: 16.3_

- [ ] 15. Roadmap App — Gus-generated long-term goals
  - [~] 15.1 Implement LearningGoal DynamoDB model
    - Define `LearningGoal`: `{id, studentId, title, description, targetDate, relatedTopics, isCompleted, completedDate}`.
    - Implement mutations: add, edit, delete, mark complete; query all goals for student.
    - _Requirements: 13.1, 13.3_

  - [~] 15.2 Implement roadmapGenerator Lambda
    - Accept `RoadmapGeneratorInput`: `{studentId}`.
    - Query DynamoDB: Progress Profile (session history, comprehension trends), Future Examinations (all deadlines), Stats weak points.
    - Query Bedrock KB for all Materials topics.
    - Call Claude with prompt: "Generate 30-90 day learning roadmap based on [context]. Prioritize exam preparation and weak points. Output 5-10 structured goals with dates."
    - Parse Claude response; persist goals to DynamoDB `roadmap` table; return `RoadmapGeneratorOutput`.
    - _Requirements: 13.2, 13.3_

  - [~] 15.3 Implement RoadmapApp component
    - Display timeline/list of learning goals covering 30-90 days.
    - Each goal shows title, target completion date, description, related topics.
    - Mark-complete button per goal; auto-refresh after session completion or exam updates.
    - _Requirements: 13.1, 13.3, 13.4, 13.5_

  - [~] 15.4 Write property test for roadmap date range constraint (Property 24)
    - **Property 24: Roadmap Date Range Constraint**
    - Generate roadmaps; assert all goal target dates are within [today + 30 days, today + 90 days].
    - **Validates: Requirements 13.2**

  - [~] 15.5 Write property test for roadmap goal structure completeness (Property 25)
    - **Property 25: Roadmap Goal Structure Completeness**
    - Generate learning goals; assert every goal includes non-empty title, description, valid target date, and at least one related topic.
    - **Validates: Requirements 13.3**

  - [~] 15.6 Write property test for roadmap goal completion update (Property 30)
    - **Property 30: Roadmap Goal Completion Update**
    - Generate goals; mark as completed; query Progress Profile and goal record; assert `isCompleted: true` and valid `completedDate`, and update is durable.
    - **Validates: Requirements 13.4**

- [ ] 16. Wire everything together and desktop app icon integration
  - [~] 16.1 Wire desktop app icons to open corresponding WindowPanel components
    - Implement double-click handlers on all 6 app icons; register window types in panel registry.
    - _Requirements: 3.2_

  - [~] 16.2 Write property test for desktop app icon double-click response (Property 28)
    - **Property 28: Desktop App Icon Double-Click Response**
    - Generate double-click events on each of 6 app icons; assert corresponding app window opens and no other windows are affected.
    - **Validates: Requirements 3.2**

  - [~] 16.3 Connect Taskbar controls to Lambda resolvers
    - Wire "Start today's session" button to `startSession` mutation → `sessionGenerator` Lambda.
    - Wire "Ask Gus" input to `askGus` mutation → `ragOrchestrator` Lambda.
    - Wire voice commands to both flows.
    - _Requirements: 4.3, 4.4, 5.3_

  - [~] 16.4 Connect all AppSync mutations to Lambda resolvers
    - Verify all mutations in GraphQL schema correctly route to corresponding Lambdas.
    - Test resolver routing with mocked handlers.
    - _Requirements: 14.1, 15.1_

  - [~] 16.5 Write integration tests for upload → Gus Q&A flow
    - Stub S3, Bedrock KB, DynamoDB; simulate upload → `materialIndexTrigger` → status `INDEXED` → `askGus` with new material in context; assert citation references uploaded document.
    - _Requirements: 7.6, 14.1, 14.4_

  - [~] 16.6 Write integration tests for session → progress update flow
    - Stub Bedrock and DynamoDB; simulate `startSession` → complete 2 topics → exit → resume; assert resume position and Progress Profile state.
    - _Requirements: 15.5, 15.6, 16.2_

- [~] 17. Final checkpoint — full suite passes
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints (tasks 2.9, 5, 10, 13, 17) ensure incremental validation at natural boundaries
- Property tests use `fast-check` with ≥ 100 iterations; tag each test `Feature: fmi-os, Property N: <title>`
- Unit tests use Jest + React Testing Library for UI components
- All AWS service calls in unit/property tests use mocks; real services only in Amplify sandbox integration tests
- The `studentId` isolation invariant (Property 2) is enforced at three layers: AppSync `@auth owner`, DynamoDB PK, and Bedrock retrieval metadata filter
- Voice command support gracefully degrades if Web Speech API unavailable (disable mic icon with tooltip)
- Calendar App supports dual integration mode (API or iframe) for flexibility
- Timetable OCR includes manual edit fallback if extraction fails or has low confidence
- All folder/file operations preserve hierarchical paths for Bedrock KB citation metadata
- Session prioritization uses multi-factor scoring: comprehension level + recency + exam urgency + weak point flag

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.6", "1.7"] },
    { "id": 2, "tasks": ["1.3", "1.5", "1.8", "2.1", "4.1"] },
    { "id": 3, "tasks": ["1.4", "2.2", "2.3", "4.2", "4.3"] },
    { "id": 4, "tasks": ["2.4", "2.6", "3.1", "4.5", "6.1"] },
    { "id": 5, "tasks": ["2.5", "2.7", "2.8", "3.2", "4.4", "4.6", "6.2"] },
    { "id": 6, "tasks": ["3.3", "3.5", "4.7", "4.8", "4.9", "6.3", "6.4", "7.1", "8.1"] },
    { "id": 7, "tasks": ["3.4", "3.6", "4.10", "8.2", "8.3", "9.1"] },
    { "id": 8, "tasks": ["9.2", "11.1", "11.2", "14.1"] },
    { "id": 9, "tasks": ["11.3", "11.6", "12.1", "14.2"] },
    { "id": 10, "tasks": ["11.4", "11.5", "11.7", "12.2", "12.3", "12.4", "14.3", "14.4"] },
    { "id": 11, "tasks": ["11.8", "12.5", "14.5", "14.6", "15.1"] },
    { "id": 12, "tasks": ["12.6", "12.7", "12.8", "15.2"] },
    { "id": 13, "tasks": ["12.9", "12.10", "15.3"] },
    { "id": 14, "tasks": ["12.11", "15.4", "15.5", "15.6"] },
    { "id": 15, "tasks": ["16.1", "16.3", "16.4"] },
    { "id": 16, "tasks": ["16.2", "16.5", "16.6"] }
  ]
}
```
