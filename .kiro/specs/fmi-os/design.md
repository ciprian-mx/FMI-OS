# Design Document

## FMI OS — Desktop Learning Environment

---

## Overview

FMI OS is a desktop operating system–style web application designed for Year 2 Computer Science students at the Faculty of Mathematics and Informatics (UNIBUC). Hosted entirely on AWS Amplify, the application provides a complete desktop environment featuring six desktop applications (Materials, Future Examinations, Calendar, Timetable, Stats, Roadmap), a boot animation, voice command support, and an AI agent named Gus. Gus is powered by Amazon Bedrock (Claude) with retrieval-augmented generation over each student's hierarchical Materials folder structure, examination deadlines, timetable constraints, and self-reported weak points. The UI is a React/TypeScript single-page application rendered as a virtual desktop with a persistent Taskbar featuring session start, voice-enabled Gus prompt, and an Account Center for profile management.

---

## Architecture

### High-Level System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                       AWS Amplify Hosting                        │
│                    React SPA (TypeScript)                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │         Boot Animation (Lottie/CSS on load)               │  │
│  │                          ↓                                 │  │
│  │  Desktop Environment (full viewport canvas)               │  │
│  │  ┌──────────────────────────────────────────────────────┐ │  │
│  │  │ 6 Desktop App Icons:                                 │ │  │
│  │  │ [Materials] [Exams] [Calendar] [Timetable] [Stats]  │ │  │
│  │  │ [Roadmap]                                            │ │  │
│  │  │                                                       │ │  │
│  │  │ Draggable App Windows (multi-window support)        │ │  │
│  │  └──────────────────────────────────────────────────────┘ │  │
│  │  ┌──────────────────────────────────────────────────────┐ │  │
│  │  │ Taskbar (fixed bottom):                              │ │  │
│  │  │ [Start Session] [Ask Gus 🎤] [Account Center]       │ │  │
│  │  └──────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬────────────────────────────────────┘
                              │ HTTPS / AppSync GraphQL
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼────────┐   ┌────────▼────────┐   ┌───────▼────────┐
│ AWS Cognito    │   │ AWS AppSync     │   │ Amplify Storage│
│ (Auth)         │   │ (GraphQL API)   │   │ (S3, Materials │
└────────────────┘   └────────┬────────┘   │ hierarchy)     │
                              │            └────────────────┘
                   ┌──────────▼────────┐
                   │ Amplify Functions │
                   │ (Lambda)          │
                   │ ┌───────────────┐ │
                   │ │ Gus RAG Orch. │ │
                   │ │ Session Gen   │ │
                   │ │ Progress Upd  │ │
                   │ │ Roadmap Gen   │ │
                   │ │ File Search   │ │
                   │ │ OCR Extract   │ │
                   │ └───────────────┘ │
                   └──────────┬────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
┌──────▼───────┐   ┌──────────▼──────┐   ┌──────────▼─────────┐
│ Amazon       │   │ Amazon Bedrock  │   │ Amazon DynamoDB    │
│ Bedrock KB   │   │ Claude (LLM)    │   │ • Progress Profile │
│ (Materials   │   │ + Textract/     │   │ • Exams Timeline   │
│  hierarchy)  │   │   Vision (OCR)  │   │ • Timetable Grid   │
└──────────────┘   └─────────────────┘   │ • Stats/Weak Points│
                                          │ • Roadmap Goals    │
                                          │ • Session State    │
                                          │ • Folder Structure │
                                          └────────────────────┘
```

### Data Flow Summary

1. **Auth & Boot**: Cognito authenticates → Boot Animation displays (skippable, <5s) → Desktop Environment loads with student-specific state restored.

2. **Materials Hierarchy Upload**: Student uploads file/folder → S3 `students/{userId}/materials/{folderPath}/` → Lambda trigger → Bedrock KB ingestion with `{studentId, folderPath}` metadata → DynamoDB status + folder tree update.

3. **Gus Multi-Source Q&A**: Student question → Lambda RAG orchestrator reads:
   - Materials KB (filtered by `studentId`)
   - Progress Profile (DynamoDB)
   - Future Examinations timeline (DynamoDB, deadlines ≤ 14 days)
   - Timetable constraints (DynamoDB)
   - Stats weak points (DynamoDB)
   → Bedrock Claude generates response with folder-path citations → response streamed back.

4. **Learning Session Generation**: Student clicks "Start" → Lambda session generator:
   - Loads Progress Profile (low comprehension topics)
   - Queries Future Examinations (urgent exams within 14 days)
   - Queries Stats (weak points)
   - Queries Timetable (class time blocks)
   - Queries Materials KB (available topics)
   → Scores topics by (urgency × weak point flag × low comprehension × recency)
   → Selects top ⌈20% of N topics⌉ (minimum 1)
   → Claude generates session plan → DynamoDB `sessions` table → session UI opens.

5. **Voice Commands**: Student clicks mic icon → Web Speech API transcribes → text populates "Ask Gus" input or triggers "Start today's session" if phrase matches.

6. **Timetable OCR**: Student uploads timetable image → Lambda invokes Textract/Bedrock Vision → extracts class names, days, times → DynamoDB grid format → UI displays editable grid.

7. **Roadmap Generation**: Student opens Roadmap app or completes session/exam update → Lambda roadmap generator:
   - Reads Progress Profile + Future Examinations + Stats + Materials topics
   → Claude generates 30-90 day learning goals
   → DynamoDB `roadmap` table → timeline view displays.

---

## Components and Interfaces

### Frontend Components

#### `BootAnimation`
Startup sequence component. Displays a Lottie animation or CSS-based boot sequence on initial authentication. Completes in <5 seconds or skips immediately on user interaction (key press, click).

```tsx
interface BootAnimationProps {
  onComplete: () => void;
  onSkip: () => void;
}
```

#### `DesktopEnvironment`
Root layout component. Renders the full-viewport canvas with 6 desktop app icons (Materials, Future Examinations, Calendar, Timetable, Stats, Roadmap) and mounts the persistent `Taskbar`. Manages panel registry (open windows, z-order, position, focus). Persists desktop state to localStorage/DynamoDB for restoration after refresh.

```tsx
interface DesktopApp {
  id: 'materials' | 'examinations' | 'calendar' | 'timetable' | 'stats' | 'roadmap';
  name: string;
  icon: React.ComponentType;
  windowComponent: React.ComponentType<WindowProps>;
}

interface WindowState {
  appId: string;
  isOpen: boolean;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  isFocused: boolean;
}

interface DesktopEnvironmentProps {
  student: AuthenticatedStudent;
  onLogout: () => void;
}
```

#### `Taskbar`
Fixed bottom bar. Always visible when authenticated. Contains three controls:
- **"Start today's session" button**: triggers learning session generation
- **"Ask Gus" input field + microphone icon**: text input or voice command for Gus queries
- **Account Center icon**: opens profile/API key/logout panel

```tsx
interface TaskbarProps {
  onStartSession: () => void;
  onGusQuery: (query: string) => void;
  onVoiceActivate: () => void;
  onAccountCenterOpen: () => void;
  isVoiceSupported: boolean;
}
```

#### `VoiceCommandHandler`
Web Speech API integration. Activated by microphone icon click. Transcribes speech to text and either:
- Populates "Ask Gus" input field with transcription, or
- Directly triggers session start if phrase is "Start today's session"

Provides visual feedback (animated mic icon) while listening. Disables mic icon with tooltip if Web Speech API unavailable.

```tsx
interface VoiceCommandHandlerProps {
  onTranscript: (text: string) => void;
  onSessionStart: () => void;
  isListening: boolean;
  isSupported: boolean;
}
```

#### `AccountCenter`
Panel/modal opened from Taskbar. Displays:
- Student email (read-only) and display name (editable)
- API key management section (view, regenerate, delete Bedrock API key)
- Logout button

Closes on outside click or Escape key.

```tsx
interface AccountCenterProps {
  student: AuthenticatedStudent;
  onUpdateProfile: (displayName: string) => Promise<void>;
  onRegenerateApiKey: () => Promise<string>;
  onDeleteApiKey: () => Promise<void>;
  onLogout: () => void;
  onClose: () => void;
}
```

#### `WindowPanel`
Generic draggable, resizable, focusable container for all desktop app windows. Wraps app content with title bar (drag handle, close button). Manages z-index and focus state.

```tsx
interface WindowPanelProps {
  title: string;
  appId: string;
  onClose: () => void;
  onFocus: () => void;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  isFocused: boolean;
  children: React.ReactNode;
}
```

#### `MaterialsApp`
Hierarchical folder/file tree view. Displays Materials Knowledge Base as a tree with:
- Root folder representing entire KB
- Nested folder structure (create, rename, move, delete folders at any level)
- File upload (drag-and-drop or picker) to any folder
- File format validation (PDF, PPTX, TXT, MD, DOCX, XLSX, PNG, JPG) and size limit (20 MB)
- Per-file indexing status indicator (Pending, Indexing, Indexed, Failed)
- Context menu for file operations (rename, move, delete)

Folder hierarchy stored in DynamoDB as adjacency list. Bedrock KB tags each chunk with `{studentId, folderPath}` metadata for path-aware citations.

```tsx
interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  children: FolderNode[];
  files: MaterialFile[];
}

interface MaterialFile {
  id: string;
  name: string;
  size: number;
  format: string;
  uploadDate: string;
  indexingStatus: 'PENDING' | 'INDEXING' | 'INDEXED' | 'FAILED';
  folderPath: string; // e.g., "Data Structures > Week 3"
  s3Key: string;
}

interface MaterialsAppProps {
  studentId: string;
  rootFolder: FolderNode;
  onUpload: (folderId: string, files: File[]) => Promise<void>;
  onCreateFolder: (parentId: string, name: string) => Promise<void>;
  onRename: (nodeId: string, newName: string) => Promise<void>;
  onMove: (nodeId: string, targetFolderId: string) => Promise<void>;
  onDelete: (nodeId: string) => Promise<void>;
}
```

#### `FutureExaminationsApp`
Timeline view of upcoming exam deadlines. Chronologically ordered. Supports:
- Add exam (name, subject, date, notes)
- Edit/delete existing exams
- Visual urgency indicator (color/icon) for exams ≤ 7 days away

Exam data stored in DynamoDB `examinations` table. Session generator queries exams with deadlines ≤ 14 days for prioritization.

```tsx
interface Examination {
  id: string;
  studentId: string;
  examName: string;
  subject: string;
  date: string; // ISO 8601
  notes?: string;
  isUrgent: boolean; // computed: ≤ 7 days
}

interface FutureExaminationsAppProps {
  examinations: Examination[];
  onAdd: (exam: Omit<Examination, 'id' | 'studentId' | 'isUrgent'>) => Promise<void>;
  onEdit: (id: string, updates: Partial<Examination>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}
```

#### `CalendarApp`
External calendar integration. Two modes:
- **API mode**: OAuth with external provider (Google Calendar, Outlook) → fetch events via API → display in calendar widget
- **Iframe mode**: Embed external calendar webpage in iframe if API unavailable

Auto-refreshes every 15 minutes while window open. Error handling for auth failures or source unavailability (error message + retry button).

```tsx
interface CalendarAppProps {
  integrationType: 'api' | 'iframe';
  externalCalendarUrl?: string;
  onAuthenticateCalendar?: () => Promise<void>;
  refreshIntervalMs: number;
}
```

#### `TimetableApp`
OCR-based timetable management. Workflow:
1. Student uploads timetable image (PNG, JPG, PDF)
2. Lambda invokes Amazon Textract or Bedrock Vision to extract class names, days, time blocks
3. Extracted data displayed in editable weekly grid (days as columns, time slots as rows)
4. Student manually adds, edits, or deletes time blocks
5. Timetable data persisted to DynamoDB in grid format

Session generator queries timetable to avoid recommending study times during class blocks.

```tsx
interface TimeBlock {
  day: 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  className: string;
  location?: string;
}

interface TimetableAppProps {
  timetable: TimeBlock[];
  onUploadImage: (file: File) => Promise<TimeBlock[]>; // OCR extraction
  onAddBlock: (block: TimeBlock) => Promise<void>;
  onEditBlock: (index: number, updates: Partial<TimeBlock>) => Promise<void>;
  onDeleteBlock: (index: number) => Promise<void>;
}
```

#### `StatsApp`
Grade and weak point tracking. Features:
- Enter grades/notes per subject or exam, organized by course/topic
- Mark topics as weak points (checkbox, rating, or text note)
- Summary view of all recorded grades and weak points

Data persisted to DynamoDB. Session generator queries Stats to prioritize weak-point topics.

```tsx
interface GradeRecord {
  id: string;
  subject: string;
  examOrTopic: string;
  grade?: number;
  notes?: string;
  date: string;
}

interface WeakPoint {
  id: string;
  topicOrSubject: string;
  severity: 'low' | 'medium' | 'high';
  notes?: string;
  flaggedDate: string;
}

interface StatsAppProps {
  grades: GradeRecord[];
  weakPoints: WeakPoint[];
  onAddGrade: (grade: Omit<GradeRecord, 'id'>) => Promise<void>;
  onEditGrade: (id: string, updates: Partial<GradeRecord>) => Promise<void>;
  onMarkWeakPoint: (weakPoint: Omit<WeakPoint, 'id'>) => Promise<void>;
  onRemoveWeakPoint: (id: string) => Promise<void>;
}
```

#### `RoadmapApp`
Long-term learning goals generated by Gus. Displays timeline/list of goals covering 30-90 days based on:
- Progress Profile (comprehension levels, session history)
- Future Examinations (upcoming deadlines)
- Stats weak points
- Materials content (available topics)

Each goal has title, target completion date, description. Students can mark goals as completed (updates Progress Profile). Auto-refreshes after session completion or exam updates.

```tsx
interface LearningGoal {
  id: string;
  title: string;
  description: string;
  targetDate: string; // ISO 8601
  relatedTopics: string[];
  isCompleted: boolean;
  completedDate?: string;
}

interface RoadmapAppProps {
  goals: LearningGoal[];
  onMarkComplete: (goalId: string) => Promise<void>;
  onRefresh: () => Promise<LearningGoal[]>;
  lastGenerated: string; // ISO 8601
}
```

#### `GusChatPanel`
Chat interface for Gus Q&A. Maintains conversation history. Streams responses. Renders citations with folder paths as expandable source links. Supports both text input and voice transcription.

```tsx
interface Message {
  id: string;
  role: 'student' | 'gus';
  content: string;
  citations?: Citation[];
  timestamp: Date;
  isError?: boolean;
}

interface Citation {
  sourceDocumentName: string;
  folderPath: string; // e.g., "Data Structures > Week 3"
  section: string;
  excerpt: string;
}

interface GusChatPanelProps {
  studentId: string;
  conversationHistory: Message[];
  onSendMessage: (message: string) => void;
  isStreaming: boolean;
}
```

#### `LearningSessionPanel`
Structured session flow UI. Steps:
1. **Plan preview**: displays selected topics, time estimates, prioritization rationale
2. **Topic-by-topic guide**: sequentially presents each topic with summary, key points, comprehension check
3. **Completion summary**: shows topics completed, progress update confirmation

Session state persisted to DynamoDB on every topic completion. Resume logic restores to `lastCompletedTopicIndex + 1`.

```tsx
type SessionStep =
  | { type: 'plan'; topics: SessionTopic[]; rationale: string }
  | { type: 'topic'; index: number; topic: SessionTopic }
  | { type: 'comprehension-check'; topicIndex: number; question: string }
  | { type: 'completed'; summary: SessionSummary };

interface SessionTopic {
  id: string;
  title: string;
  estimatedMinutes: number;
  summary: string;
  keyPoints: string[];
  comprehensionQuestion: string;
  sourceFiles: string[]; // folder paths
}

interface SessionSummary {
  topicsCompleted: number;
  totalMinutes: number;
  comprehensionUpdates: { topicId: string; level: ComprehensionLevel }[];
}

interface LearningSessionPanelProps {
  session: Session;
  currentStep: SessionStep;
  onNextTopic: () => void;
  onSubmitComprehension: (result: ComprehensionLevel) => void;
  onExit: () => void;
}
```

---

### Backend: Amplify Functions (Lambda)

#### `ragOrchestrator`
Handles Gus Q&A with multi-source context.

```typescript
interface GusQueryInput {
  studentId: string;
  sessionId: string;
  message: string;
  conversationHistory: ConversationTurn[];
}

interface GusQueryOutput {
  response: string;
  citations: Citation[];
}
```

**Steps:**
1. Retrieve relevant chunks from Bedrock KB with filter `{ studentId, folderPath }`.
2. Query DynamoDB:
   - Progress Profile (comprehension levels, last studied dates)
   - Future Examinations (deadlines ≤ 14 days)
   - Timetable (class time blocks)
   - Stats (weak points)
3. Build system prompt injecting all context sources.
4. Call Claude via Bedrock `InvokeModel` with full conversation history.
5. Parse response, extract citations with folder paths.
6. Return response + citations.

#### `sessionGenerator`
Generates 80/20 Learning Session plan with multi-source prioritization.

```typescript
interface SessionGeneratorInput {
  studentId: string;
}

interface SessionGeneratorOutput {
  sessionId: string;
  topics: SessionTopic[];
  totalEstimatedMinutes: number;
  rationale: string;
}
```

**Steps:**
1. Query DynamoDB:
   - Progress Profile (low comprehension topics, old last-studied dates)
   - Future Examinations (exams with deadline ≤ 14 days)
   - Stats (weak point topics)
   - Timetable (class time constraints)
2. Query Bedrock KB for all available topics (filtered by `studentId`).
3. Score each topic: `(urgency_weight × exam_proximity) + (weak_point_flag × 2) + (1 / comprehension_level) + recency_penalty`.
4. Select top N topics where N = ⌈0.20 × total_topics⌉, minimum 1.
5. For each selected topic, call Claude to generate summary, key points, comprehension question from Materials chunks.
6. Persist session plan to DynamoDB `sessions` table with status `IN_PROGRESS`.
7. Return plan + rationale.

#### `roadmapGenerator`
Generates 30-90 day learning goals.

```typescript
interface RoadmapGeneratorInput {
  studentId: string;
}

interface RoadmapGeneratorOutput {
  goals: LearningGoal[];
  generatedDate: string;
}
```

**Steps:**
1. Query DynamoDB:
   - Progress Profile (session history, comprehension trends)
   - Future Examinations (all upcoming deadlines)
   - Stats (weak points)
2. Query Bedrock KB for all Materials topics.
3. Call Claude with prompt: "Generate a 30-90 day learning roadmap for a student with [context]. Prioritize exam preparation and weak points. Output structured goals with dates."
4. Parse Claude response into structured goals.
5. Persist to DynamoDB `roadmap` table.
6. Return goals.

#### `fileSearchHandler`
Handles Gus resource search in Materials hierarchy.

```typescript
interface FileSearchInput {
  studentId: string;
  query: string; // natural language, e.g., "Find my data structures notes from week 3"
}

interface FileSearchOutput {
  results: SearchResult[];
}

interface SearchResult {
  fileId: string;
  fileName: string;
  folderPath: string;
  relevanceScore: number;
}
```

**Steps:**
1. Query DynamoDB folder structure + file metadata for `studentId`.
2. Use semantic search (Bedrock KB metadata query) or keyword matching on file names, folder names, file content summaries.
3. Rank results by relevance score.
4. Return list with folder paths for UI navigation.

#### `timetableOcrHandler`
Extracts timetable data from uploaded image.

```typescript
interface TimetableOcrInput {
  studentId: string;
  imageS3Key: string;
}

interface TimetableOcrOutput {
  timeBlocks: TimeBlock[];
}
```

**Steps:**
1. Invoke Amazon Textract `AnalyzeDocument` or Bedrock Vision model on S3 image.
2. Parse OCR output to extract class names, days, time ranges.
3. Structure data into `TimeBlock[]` format.
4. Persist to DynamoDB `timetable` table.
5. Return extracted blocks for UI display.

#### `progressUpdater`
Handles comprehension check results and manual overrides.

```typescript
interface ProgressUpdateInput {
  studentId: string;
  topicId: string;
  updateType: 'comprehension-check' | 'manual-override';
  comprehensionLevel: 'none' | 'low' | 'medium' | 'high';
  sessionId?: string;
}
```

#### `materialIndexTrigger`
S3 event trigger Lambda. Fires when a file lands in `students/{userId}/materials/{folderPath}/`. Starts Bedrock KB ingestion job with `{studentId, folderPath}` metadata tags. Writes `INDEXING` status to DynamoDB folder structure table.

---

### AppSync GraphQL Schema

```graphql
type Student @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  email: String!
  displayName: String
  apiKeyHash: String
}

type FolderNode @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  name: String!
  parentId: ID
  path: String! # full path for indexing, e.g., "Data Structures/Week 3"
  createdDate: AWSDateTime!
}

type MaterialFile @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  folderId: ID!
  name: String!
  size: Int!
  format: String!
  uploadDate: AWSDateTime!
  indexingStatus: IndexingStatus!
  s3Key: String!
  folderPath: String!
}

enum IndexingStatus {
  PENDING
  INDEXING
  INDEXED
  FAILED
}

type Examination @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  examName: String!
  subject: String!
  date: AWSDateTime!
  notes: String
}

type TimeBlock @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  day: Day!
  startTime: String! # HH:MM
  endTime: String! # HH:MM
  className: String!
  location: String
}

enum Day {
  MONDAY
  TUESDAY
  WEDNESDAY
  THURSDAY
  FRIDAY
  SATURDAY
  SUNDAY
}

type GradeRecord @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  subject: String!
  examOrTopic: String!
  grade: Float
  notes: String
  date: AWSDateTime!
}

type WeakPoint @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  topicOrSubject: String!
  severity: Severity!
  notes: String
  flaggedDate: AWSDateTime!
}

enum Severity {
  LOW
  MEDIUM
  HIGH
}

type LearningGoal @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  title: String!
  description: String!
  targetDate: AWSDateTime!
  relatedTopics: [String!]!
  isCompleted: Boolean!
  completedDate: AWSDateTime
}

type TopicProgress @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  topicId: String!
  topicTitle: String!
  lastStudiedDate: AWSDateTime
  comprehensionLevel: ComprehensionLevel!
  sessionCount: Int!
  manualOverride: Boolean!
}

enum ComprehensionLevel {
  NONE
  LOW
  MEDIUM
  HIGH
}

type Session @model @auth(rules: [{ allow: owner }]) {
  id: ID!
  studentId: ID! @index(name: "byStudent")
  createdAt: AWSDateTime!
  status: SessionStatus!
  lastCompletedTopicIndex: Int!
  topics: [SessionTopic!]!
  rationale: String!
}

enum SessionStatus {
  IN_PROGRESS
  COMPLETED
  ABANDONED
}

type SessionTopic {
  id: String!
  title: String!
  estimatedMinutes: Int!
  summary: String!
  keyPoints: [String!]!
  comprehensionQuestion: String!
  sourceFiles: [String!]!
  completedAt: AWSDateTime
  comprehensionResult: ComprehensionLevel
}

type Mutation {
  askGus(input: GusQueryInput!): GusQueryOutput!
    @function(name: "ragOrchestrator")
  searchFiles(input: FileSearchInput!): FileSearchOutput!
    @function(name: "fileSearchHandler")
  startSession(studentId: ID!): Session!
    @function(name: "sessionGenerator")
  generateRoadmap(studentId: ID!): RoadmapGeneratorOutput!
    @function(name: "roadmapGenerator")
  extractTimetable(input: TimetableOcrInput!): TimetableOcrOutput!
    @function(name: "timetableOcrHandler")
  updateProgress(input: ProgressUpdateInput!): TopicProgress!
    @function(name: "progressUpdater")
}
```

---

## Data Models

### DynamoDB Access Patterns

All tables use `studentId` as partition key for isolation.

| Table | PK | SK | Purpose |
|---|---|---|---|
| `FolderNodes` | `studentId` | `folderId` | Folder hierarchy (adjacency list) |
| `MaterialFiles` | `studentId` | `fileId` | File metadata + indexing status + folder path |
| `Examinations` | `studentId` | `examId` | Exam deadlines timeline |
| `TimeBlocks` | `studentId` | `blockId` | Timetable grid cells |
| `GradeRecords` | `studentId` | `gradeId` | Grade entries |
| `WeakPoints` | `studentId` | `weakPointId` | Self-reported weak topics |
| `LearningGoals` | `studentId` | `goalId` | Roadmap goals |
| `TopicProgress` | `studentId` | `topicId` | Comprehension levels, last studied dates |
| `Sessions` | `studentId` | `sessionId` | Session plans, completion state |
| `ConversationHistory` | `studentId` | `sessionId#messageId` | Chat turns for context |
| `DesktopState` | `studentId` | `stateId` | Window positions, open apps (for restore) |

### Bedrock Knowledge Base Architecture

Each student's Materials are indexed in Bedrock KB with metadata tags:
- `studentId`: UUID (enforces isolation via retrieval filter)
- `folderPath`: full path string, e.g., "Data Structures/Week 3/Sorting.pdf"
- `fileName`: original filename

**Ingestion workflow:**
1. File uploaded to S3 `students/{studentId}/materials/{folderPath}/{fileName}`
2. Lambda trigger reads folder path from S3 key
3. Bedrock KB ingestion job started with metadata `{studentId, folderPath}`
4. All retrieval queries include filter: `{ equals: { key: "studentId", value: studentId } }`

**Citation format:** Citations include `folderPath` extracted from KB metadata, enabling UI to display "Data Structures > Week 3 > Sorting.pdf" instead of S3 key.

### Folder Hierarchy Storage

**Adjacency List Model in DynamoDB:**

```typescript
interface FolderNode {
  id: string; // UUID
  studentId: string; // PK
  name: string; // display name
  parentId: string | null; // null = root
  path: string; // computed full path, e.g., "Data Structures/Week 3"
  createdDate: string;
}
```

**Operations:**
- **Create folder**: Insert row with `parentId` pointing to parent folder
- **Move folder**: Update `parentId` + recompute `path` recursively for all descendants
- **Delete folder**: Recursive delete of all descendants + trigger KB deletion for all files

### Progress Profile Schema

```typescript
interface ProgressProfile {
  studentId: string;
  topics: TopicRecord[];
  lastUpdated: string;
}

interface TopicRecord {
  topicId: string;
  topicTitle: string;
  sourceDocumentIds: string[]; // references MaterialFiles
  comprehensionLevel: 'none' | 'low' | 'medium' | 'high';
  lastStudiedDate: string | null;
  sessionCount: number;
  manualOverride: boolean;
}
```

---

### Auth Flow

1. **Registration**: `POST /auth/register` (Cognito) validates university email domain (e.g., `@s.unibuc.ro`), creates user.
2. **Login**: Cognito returns JWT tokens (id_token, access_token, refresh_token).
3. **Boot sequence**: On successful auth, Boot Animation displays → Desktop Environment loads with restored state.
4. All AppSync requests include `Authorization: Bearer {id_token}`. Cognito authorizer injects `sub` (studentId) into Lambda context.
5. **Token expiry**: Amplify Auth silently refreshes; on failure, redirects to `/login` with last desktop state stored.

### Materials Upload Interface

```typescript
const uploadToFolder = async (
  folderId: string,
  files: File[],
  studentId: string
): Promise<UploadResult[]> => {
  // Get folder path from DynamoDB
  const folderPath = await getFolderPath(folderId);
  
  // Validate files
  const results = await Promise.all(
    files.map(async (file) => {
      const validation = validateFile(file);
      if (!validation.valid) return { file, error: validation.error };
      
      const key = `students/${studentId}/materials/${folderPath}/${file.name}`;
      await Storage.put(key, file, {
        contentType: file.type,
        metadata: { studentId, folderPath },
      });
      
      // Create MaterialFile record in DynamoDB
      await API.graphql({
        query: createMaterialFile,
        variables: {
          input: {
            studentId,
            folderId,
            name: file.name,
            size: file.size,
            format: file.type,
            s3Key: key,
            folderPath,
            indexingStatus: 'PENDING',
          },
        },
      });
      
      return { file, success: true };
    })
  );
  
  return results;
};

const validateFile = (file: File): { valid: boolean; error?: string } => {
  const ALLOWED_FORMATS = ['pdf', 'pptx', 'txt', 'md', 'docx', 'xlsx', 'png', 'jpg', 'jpeg'];
  const MAX_SIZE = 20 * 1024 * 1024; // 20 MB
  
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext || !ALLOWED_FORMATS.includes(ext)) {
    return { valid: false, error: 'Unsupported file format. Allowed: PDF, PPTX, TXT, MD, DOCX, XLSX, PNG, JPG.' };
  }
  
  if (file.size > MAX_SIZE) {
    return { valid: false, error: 'File exceeds 20 MB limit.' };
  }
  
  return { valid: true };
};
```

### Gus Multi-Source Query Interface

```typescript
const askGus = async (
  message: string,
  conversationHistory: ConversationTurn[]
): Promise<GusQueryOutput> => {
  const result = await API.graphql({
    query: askGusMutation,
    variables: {
      input: {
        studentId: currentUser.id,
        sessionId: currentSessionId,
        message,
        conversationHistory,
      },
    },
  });
  
  return result.data.askGus;
};

// Lambda ragOrchestrator context assembly
const buildMultiSourceContext = async (studentId: string) => {
  const [progressProfile, examinations, timetable, stats] = await Promise.all([
    dynamoDB.query({ PK: studentId, table: 'TopicProgress' }),
    dynamoDB.query({ PK: studentId, table: 'Examinations' }).then(filterWithin14Days),
    dynamoDB.query({ PK: studentId, table: 'TimeBlocks' }),
    dynamoDB.query({ PK: studentId, table: 'WeakPoints' }),
  ]);
  
  return {
    progressProfile: formatProgressSummary(progressProfile),
    upcomingExams: formatExamSummary(examinations),
    classTimes: formatTimetableSummary(timetable),
    weakPoints: formatWeakPointsSummary(stats),
  };
};
```

### Voice Command Integration

```typescript
const activateVoiceCommand = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      reject(new Error('Web Speech API not supported'));
      return;
    }
    
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      resolve(transcript);
    };
    
    recognition.onerror = (event) => {
      reject(new Error(event.error));
    };
    
    recognition.start();
  });
};

const handleVoiceInput = async () => {
  try {
    const transcript = await activateVoiceCommand();
    
    if (transcript.toLowerCase().includes('start today\'s session') || 
        transcript.toLowerCase().includes('start session')) {
      onStartSession();
    } else {
      setGusInputValue(transcript);
    }
  } catch (error) {
    console.error('Voice recognition failed:', error);
    showToast('Voice command failed. Please try typing instead.');
  }
};
```

### Session Resume Logic

```typescript
const loadOrStartSession = async (studentId: string): Promise<Session> => {
  // Query most recent IN_PROGRESS session
  const existingSessions = await API.graphql({
    query: listSessions,
    variables: {
      filter: {
        studentId: { eq: studentId },
        status: { eq: 'IN_PROGRESS' },
      },
      sort: { field: 'createdAt', direction: 'DESC' },
      limit: 1,
    },
  });
  
  if (existingSessions.data.listSessions.items.length > 0) {
    const session = existingSessions.data.listSessions.items[0];
    // Resume from next incomplete topic
    return session;
  }
  
  // No existing session, generate new one
  const newSession = await API.graphql({
    query: startSessionMutation,
    variables: { studentId },
  });
  
  return newSession.data.startSession;
};
```

---

## Error Handling

### Authentication Errors

| Scenario | Behavior |
|---|---|
| Invalid credentials | Generic error: "Email or password is incorrect." No field-specific disclosure. |
| Unrecognized email domain | Registration validation: "Please use your university email address." |
| Session token expired | Silent refresh; on failure, redirect to `/login` with desktop state stored for restore. |

### Upload Errors

| Scenario | Behavior |
|---|---|
| File > 20 MB | Client rejects before upload: "File exceeds the 20 MB limit." |
| Unsupported format | Client rejects: "Supported formats: PDF, PPTX, TXT, MD, DOCX, XLSX, PNG, JPG." |
| S3 upload failure | Toast error with retry button. |
| Indexing failure | MaterialFile status → `FAILED` in DynamoDB; UI shows "Indexing failed — try re-uploading." with retry action. |

### Gus / Bedrock Errors

| Scenario | Behavior |
|---|---|
| Bedrock timeout (>10s) | Lambda catches timeout; returns structured error; UI shows "Gus is taking longer than usual. Retry?" |
| Bedrock service error | Same pattern; logged to CloudWatch with request ID. |
| Empty Knowledge Base | Gus returns templated message: "I don't have any materials to reference yet. Upload files in the Materials app to get started!" |
| Multi-source context fetch failure | Degrade gracefully: generate response with available context sources, log warning. |

### OCR Errors

| Scenario | Behavior |
|---|---|
| Textract/Vision extraction failure | Toast error: "Could not extract timetable. Please try a clearer image or enter manually." Manual grid editor remains available. |
| Low-confidence extraction | UI displays extracted data with warning badge: "Please review and correct extracted entries." |

### Voice Command Errors

| Scenario | Behavior |
|---|---|
| Web Speech API unavailable | Microphone icon disabled with tooltip: "Voice commands not supported in this browser." |
| Recognition failure | Toast error: "Voice recognition failed. Please try typing instead." |
| Ambiguous transcription | Populate "Ask Gus" input with transcription; let student review before submitting. |

### Session Errors

| Scenario | Behavior |
|---|---|
| Session generation failure (no topics) | Toast: "No topics available for session generation. Upload materials first." |
| Progress save failure | Retry with exponential backoff (3 attempts); if all fail, toast warning: "Progress may not be saved. Check your connection." |

---

## Security Considerations

- **Row-level isolation**: All DynamoDB tables use `studentId` PK. AppSync resolvers use `@auth(rules: [{ allow: owner }])` which injects Cognito `sub` automatically.
- **S3 prefix isolation**: IAM policy restricts each student to `students/{cognito:sub}/*` via condition key.
- **Knowledge Base retrieval filter**: Every Bedrock KB retrieval call includes mandatory `{ equals: { key: "studentId", value: studentId } }` filter enforced in Lambda.
- **Folder path validation**: Lambda validates all folder operations to prevent path traversal attacks (e.g., `../` sequences rejected).
- **API key security**: Bedrock API keys hashed in DynamoDB; regeneration invalidates old key immediately.
- **Input validation**: File format/size validated client + server-side. GraphQL types strictly enforced. OCR output sanitized before storage.
- **No secrets in frontend**: All Bedrock, Textract, and DynamoDB calls from Lambda only. Frontend never holds AWS credentials.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

---

### Property 1: Generic Authentication Error Messages

*For any* invalid (email, password) pair submitted to the authentication system, the returned error message SHALL be identical regardless of which field is incorrect — never revealing whether the email or password specifically caused the failure.

**Validates: Requirements 1.3**

---

### Property 2: Student Data Isolation

*For any* two distinct student IDs A and B, no query, mutation, or retrieval operation authenticated as student A SHALL return, modify, or reference any data belonging to student B (Materials files/folders, Progress Profile, Future Examinations, Timetable, Stats, Roadmap, Sessions, Knowledge Base chunks).

**Validates: Requirements 1.5**

---

### Property 3: Boot Animation Skippability

*For any* user input event (key press, mouse click, touch) occurring during the Boot Animation display, the animation SHALL immediately terminate and transition to the Desktop Environment.

**Validates: Requirements 2.3**

---

### Property 4: Desktop Window Management Independence

*For any* set of open Desktop App windows, each window SHALL maintain independent focus state, position, size, and z-index — modifying one window's properties SHALL NOT affect any other window's properties.

**Validates: Requirements 3.3**

---

### Property 5: State Persistence Round-Trip

*For any* Desktop Environment state S (window positions, sizes, open apps, focused app), persisting S and then restoring it (via page refresh or re-authentication) SHALL produce an equivalent state S' where all windows are in the same positions, have the same sizes, and the same app focus.

**Validates: Requirements 3.5, 11.6, 12.5**

---

### Property 6: Responsive Layout Invariant

*For any* viewport width W where W ≥ 1024px, the Desktop Environment SHALL render without horizontal overflow, all desktop app icons SHALL remain visible and clickable, and the Taskbar SHALL remain visible and fully usable.

**Validates: Requirements 3.6**

---

### Property 7: Taskbar Persistent Visibility

*For any* authenticated UI state (any open panels, any route, any scroll position, any desktop configuration), the Taskbar SHALL be visible at the bottom of the viewport and all three controls ("Start today's session" button, "Ask Gus" input with microphone, Account Center icon) SHALL be present and actionable.

**Validates: Requirements 4.1**

---

### Property 8: File Format and Size Validation

*For any* file F submitted to the Materials upload system, F SHALL be accepted if and only if:
- F's extension is in {pdf, pptx, txt, md, docx, xlsx, png, jpg, jpeg}, AND
- F's size ≤ 20,971,520 bytes (20 MB)

For any file not meeting these criteria, the system SHALL reject the upload with an error message specifying allowed formats and size limit.

**Validates: Requirements 7.4, 7.5**

---

### Property 9: Folder Hierarchy Citation Preservation

*For any* file F at folder path P in the Materials hierarchy, if Gus generates a response citing content from F, the citation SHALL include the full folder path P (e.g., "Data Structures > Week 3 > Sorting.pdf") — not only the filename or S3 key.

**Validates: Requirements 7.9, 14.4**

---

### Property 10: Materials Tree View Correctness

*For any* folder/file structure stored for a student, the Materials App tree view SHALL display exactly that structure — every folder and file present in DynamoDB SHALL appear in the tree, and no folder/file SHALL appear that is not in DynamoDB.

**Validates: Requirements 7.1**

---

### Property 11: Hierarchical Folder Operations

*For any* folder F in the Materials hierarchy and any operation (create child folder, upload file, rename, move, delete), the operation SHALL succeed and propagate correctly to all descendants (e.g., deleting folder F SHALL delete all child folders and files recursively; moving F SHALL update folderPath for all descendants).

**Validates: Requirements 7.2, 7.3, 7.8**

---

### Property 12: Exam Timeline Chronological Ordering

*For any* set of examination deadlines E stored for a student, the Future Examinations App timeline view SHALL display E in strictly chronological order by date — no exam with an earlier date SHALL appear after an exam with a later date.

**Validates: Requirements 9.1**

---

### Property 13: Exam Urgency Highlighting

*For any* examination E with deadline date D, if (D - today) ≤ 7 days, then E SHALL display a visual urgency indicator (color or icon) in the Future Examinations App.

**Validates: Requirements 9.5**

---

### Property 14: Timetable Conflict Avoidance

*For any* Learning Session plan P and Timetable T containing time blocks, P SHALL NOT recommend any study time that overlaps with any time block in T — all session activity times SHALL fall outside class time ranges.

**Validates: Requirements 11.5, 15.7**

---

### Property 15: Gus Multi-Source Context Inclusion

*For any* question Q submitted to Gus by a student with non-empty Materials KB, at least one Future Examination, at least one Timetable entry, and at least one Stats weak point, Gus's response generation process SHALL query and incorporate context from all five sources (Materials KB, Progress Profile, Future Examinations, Timetable, Stats) — no source SHALL be ignored.

**Validates: Requirements 14.1, 15.1**

---

### Property 16: Conversational Context Preservation

*For any* sequence of messages M = [m₁, m₂, ..., mₙ] within a single Gus chat session, if message mᵢ introduces entity E and message mⱼ (j > i) refers to E without re-defining it, then Gus's response to mⱼ SHALL correctly resolve E to the entity introduced in mᵢ — Gus SHALL NOT treat mⱼ as context-free.

**Validates: Requirements 14.5**

---

### Property 17: 20% Topic Cap in Learning Sessions

*For any* student with N available topics in their Materials KB, a generated Learning Session plan SHALL select at most ⌈0.20 × N⌉ topics (minimum 1), and each selected topic SHALL include:
- Title
- Estimated duration in minutes
- Summary
- Key points
- Comprehension check question

**Validates: Requirements 15.2, 15.3**

---

### Property 18: Weak Point Prioritization

*For any* set of topics T and Stats data S where subset T_weak ⊆ T is marked as weak points in S, when generating a Learning Session plan, the session generator SHALL assign higher priority scores to topics in T_weak than to topics in T \ T_weak with equivalent comprehension levels and recency.

**Validates: Requirements 12.4, 15.2**

---

### Property 19: Exam Urgency Prioritization

*For any* set of topics T and Future Examinations E where subset T_urgent ⊆ T relates to exams in E with deadlines ≤ 14 days, when generating a Learning Session plan, the session generator SHALL assign higher priority scores to topics in T_urgent than to topics in T \ T_urgent with equivalent weak point flags and comprehension levels.

**Validates: Requirements 9.4, 15.2**

---

### Property 20: Session Resume Correctness

*For any* Learning Session S in which the student completes topics 0 through K (0-indexed) and then exits, resuming session S SHALL place the student at topic K+1 — not earlier, not later — and all topics 0..K SHALL be marked complete with recorded comprehension results.

**Validates: Requirements 15.6**

---

### Property 21: Comprehension Check Progress Update

*For any* comprehension check completed during a Learning Session on topic T with result R, the student's Progress Profile SHALL be updated such that topic T's comprehension level reflects R, and the update SHALL be durable (a subsequent query SHALL return the updated level).

**Validates: Requirements 15.5, 16.2**

---

### Property 22: Progress Profile Completeness

*For any* Progress Profile for a student, every topic T recorded SHALL include:
- Topic ID
- Topic title
- Last studied date (or null if never studied)
- Comprehension level
- Session count

No topic SHALL be missing any of these fields.

**Validates: Requirements 16.1**

---

### Property 23: Low Comprehension Prioritization

*For any* Progress Profile P containing topics with varying comprehension levels, the session generator SHALL rank topics with lower comprehension levels higher than topics with higher comprehension levels (when urgency and weak point flags are equal), and among topics with equal comprehension, SHALL rank topics with older (or absent) last-studied dates higher.

**Validates: Requirements 16.3**

---

### Property 24: Roadmap Date Range Constraint

*For any* generated Roadmap R for a student, all learning goals in R SHALL have target completion dates within the range [today + 30 days, today + 90 days] — no goal SHALL have a target date < 30 days or > 90 days from generation date.

**Validates: Requirements 13.2**

---

### Property 25: Roadmap Goal Structure Completeness

*For any* learning goal G displayed in the Roadmap App, G SHALL include:
- Non-empty title
- Non-empty description
- Valid target completion date
- At least one related topic

No goal SHALL be missing any of these fields.

**Validates: Requirements 13.3**

---

### Property 26: Account Center Close Triggers

*For any* open Account Center panel, the panel SHALL close when:
- The student clicks outside the panel bounds, OR
- The student presses the Escape key

Both triggers SHALL independently close the panel.

**Validates: Requirements 6.5**

---

### Property 27: Voice Transcription Accuracy Propagation

*For any* transcribed text T produced by the Voice Command System from spoken input, T SHALL populate the "Ask Gus" input field exactly as transcribed — no characters SHALL be added, removed, or modified between transcription and display.

**Validates: Requirements 5.2**

---

### Property 28: Desktop App Icon Double-Click Response

*For any* desktop app icon I representing one of the six apps {Materials, Future Examinations, Calendar, Timetable, Stats, Roadmap}, double-clicking I SHALL open the corresponding app in a draggable window, and no other app window SHALL open or close as a result.

**Validates: Requirements 3.2**

---

### Property 29: File Search Result Navigation Correctness

*For any* file search result R returned by Gus resource search with folder path P and file name F, clicking the navigation link for R SHALL open the Materials App window and expand the folder tree to reveal the file at path P with name F highlighted or selected.

**Validates: Requirements 8.3**

---

### Property 30: Roadmap Goal Completion Update

*For any* learning goal G in the Roadmap App, marking G as completed SHALL update the student's Progress Profile to reflect completion, and the update SHALL be durable (a subsequent query SHALL return G with `isCompleted: true` and a valid `completedDate`).

**Validates: Requirements 13.4**

---

## Testing Strategy

### Dual Testing Approach

Both unit/example-based tests and property-based tests are complementary and necessary.

**Unit tests** cover:
- Specific UI interactions (clicking Taskbar button opens session panel, double-clicking Materials icon opens Materials window)
- Component integration (AppSync mutations correctly wired to Lambda resolvers, Bedrock KB retrieval filter applied)
- Error condition rendering (Bedrock timeout displays friendly message + retry button, OCR failure shows manual entry fallback)
- Voice command specific phrase recognition ("Start today's session" triggers session generation)

**Property tests** cover the 30 properties listed above. Each property test MUST:
- Run a minimum of 100 iterations with randomly generated inputs
- Be tagged: `Feature: fmi-os, Property {N}: {property_title}`
- Use mocks for external AWS services (Bedrock, DynamoDB, Textract) in unit-level property tests
- Use real services in integration tests for end-to-end validation

### Recommended Libraries

| Layer | Library | Purpose |
|---|---|---|
| Frontend (React) | `fast-check` | TypeScript property-based testing |
| Lambda (Node.js) | `fast-check` | Backend property tests |
| Integration tests | AWS SDK + Vitest/Jest | Real Amplify sandbox environment |
| UI component tests | React Testing Library + `fast-check` | Component property tests |
| Voice API mocks | Custom mock `SpeechRecognition` | Simulate transcription for testing |

### Example Property Test (Property 8 — File Validation)

```typescript
import * as fc from 'fast-check';
import { validateUpload } from '../src/utils/uploadValidation';

const ALLOWED_EXTENSIONS = ['pdf', 'pptx', 'txt', 'md', 'docx', 'xlsx', 'png', 'jpg', 'jpeg'];
const MAX_BYTES = 20 * 1024 * 1024;

test('Property 8: file validation accepts iff format and size valid', () => {
  fc.assert(
    fc.property(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 100 }),
        extension: fc.oneof(
          fc.constantFrom(...ALLOWED_EXTENSIONS),
          fc.string({ minLength: 1, maxLength: 5 }).filter(
            (ext) => !ALLOWED_EXTENSIONS.includes(ext.toLowerCase())
          )
        ),
        size: fc.integer({ min: 0, max: MAX_BYTES * 2 }),
      }),
      ({ name, extension, size }) => {
        const file = { name: `${name}.${extension}`, size };
        const result = validateUpload(file);
        const shouldAccept =
          ALLOWED_EXTENSIONS.includes(extension.toLowerCase()) &&
          size <= MAX_BYTES;
        return result.valid === shouldAccept;
      }
    ),
    { numRuns: 500 }
  );
});
```

### Example Property Test (Property 17 — 20% Topic Cap)

```typescript
import * as fc from 'fast-check';
import { generateSessionPlan } from '../src/session/sessionGenerator';

test('Property 17: session covers at most 20% of topics', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          id: fc.uuid(),
          title: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        { minLength: 1, maxLength: 100 }
      ),
      fc.array(
        fc.record({
          topicId: fc.string(),
          comprehensionLevel: fc.constantFrom('none', 'low', 'medium', 'high'),
          lastStudiedDate: fc.option(fc.date()),
        })
      ),
      fc.array(
        fc.record({
          examId: fc.uuid(),
          date: fc.date({ min: new Date(), max: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }),
          relatedTopicIds: fc.array(fc.string(), { maxLength: 3 }),
        })
      ),
      (allTopics, progressRecords, examinations) => {
        const plan = generateSessionPlan({
          topics: allTopics,
          progress: progressRecords,
          examinations,
          timetable: [],
          weakPoints: [],
        });
        
        const maxAllowed = Math.ceil(0.2 * allTopics.length);
        const meetsTopicCap = plan.topics.length <= maxAllowed && plan.topics.length >= 1;
        const allTopicsComplete = plan.topics.every(
          (topic) =>
            topic.title &&
            topic.estimatedMinutes > 0 &&
            topic.summary &&
            topic.keyPoints.length > 0 &&
            topic.comprehensionQuestion
        );
        
        return meetsTopicCap && allTopicsComplete;
      }
    ),
    { numRuns: 200 }
  );
});
```

### Example Property Test (Property 14 — Timetable Conflict Avoidance)

```typescript
import * as fc from 'fast-check';
import { generateSessionPlan, timeBlocksOverlap } from '../src/session/sessionGenerator';

test('Property 14: session times do not conflict with timetable', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          day: fc.constantFrom('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'),
          startTime: fc.integer({ min: 8, max: 18 }).map((h) => `${h}:00`),
          endTime: fc.integer({ min: 9, max: 19 }).map((h) => `${h}:00`),
          className: fc.string({ minLength: 1 }),
        }),
        { maxLength: 20 }
      ),
      fc.array(
        fc.record({
          id: fc.uuid(),
          title: fc.string(),
        }),
        { minLength: 1, maxLength: 50 }
      ),
      (timetable, topics) => {
        const plan = generateSessionPlan({
          topics,
          progress: [],
          examinations: [],
          timetable,
          weakPoints: [],
        });
        
        // Check that no recommended study time overlaps with timetable
        return plan.recommendedStudyTimes.every((studyTime) =>
          timetable.every((classTime) => !timeBlocksOverlap(studyTime, classTime))
        );
      }
    ),
    { numRuns: 200 }
  );
});
```

### Example Property Test (Property 2 — Data Isolation)

```typescript
import * as fc from 'fast-check';
import { queryStudentData } from '../src/data/studentRepository';

test('Property 2: student data isolation', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uuid(), // studentA
      fc.uuid(), // studentB
      fc.constantFrom('Materials', 'Progress', 'Examinations', 'Timetable', 'Stats', 'Roadmap'),
      async (studentA, studentB, dataType) => {
        fc.pre(studentA !== studentB); // Skip if same student
        
        // Query data authenticated as studentA
        const dataForA = await queryStudentData(studentA, dataType);
        
        // Verify no data belongs to studentB
        const containsStudentBData = dataForA.some(
          (item) => item.studentId === studentB
        );
        
        return !containsStudentBData;
      }
    ),
    { numRuns: 100 }
  );
});
```

### Example Property Test (Property 9 — Folder Path Citations)

```typescript
import * as fc from 'fast-check';
import { askGus } from '../src/gus/ragOrchestrator';

test('Property 9: citations include full folder paths', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          fileId: fc.uuid(),
          fileName: fc.string({ minLength: 1 }),
          folderPath: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 })
            .map((parts) => parts.join(' > ')),
          content: fc.lorem({ maxCount: 3 }),
        }),
        { minLength: 1, maxLength: 10 }
      ),
      fc.lorem({ maxCount: 1 }),
      async (materials, question) => {
        // Mock KB with materials
        mockBedrockKB(materials);
        
        const response = await askGus({
          studentId: 'test-student',
          message: question,
          conversationHistory: [],
        });
        
        // If response has citations, all must include folder paths
        if (response.citations && response.citations.length > 0) {
          return response.citations.every(
            (citation) =>
              citation.folderPath &&
              citation.folderPath.length > 0 &&
              citation.folderPath.includes(' > ') // Path separator present
          );
        }
        
        return true; // No citations is acceptable if question not grounded in KB
      }
    ),
    { numRuns: 100 }
  );
});
```

---

## Implementation Notes

### Boot Animation
- Use Lottie for vector animation (recommended) or CSS keyframes for simpler animations
- Duration target: 3-4 seconds (requirement: <5s)
- Skip implementation: attach event listeners to `document` for any keydown/click during animation
- Transition: fade-out animation → fade-in Desktop Environment

### Folder Hierarchy Performance
- For large hierarchies (>1000 nodes), implement lazy loading in tree view (expand on demand)
- Cache folder path computations in DynamoDB `path` field to avoid recursive queries
- Use DynamoDB streams to trigger path recomputation on move/rename operations

### Voice Command Browser Support
- Primary: Chrome/Edge (best Web Speech API support)
- Firefox: partial support with fallback
- Safari: limited support (show warning tooltip)
- Fallback UI: always provide text input alternative

### Multi-Source Context Token Budget
- Bedrock Claude context window: ~100k tokens (Claude 2.1)
- Allocate budget:
  - Materials KB retrieval: 40k tokens (top 20 chunks)
  - Progress Profile summary: 5k tokens
  - Examinations (next 14 days): 2k tokens
  - Timetable: 2k tokens
  - Stats weak points: 1k tokens
  - Conversation history: 30k tokens
  - Response generation: 20k tokens

### Session Prioritization Scoring Formula

```typescript
const calculateTopicScore = (
  topic: Topic,
  progress: TopicProgress,
  examinations: Examination[],
  weakPoints: WeakPoint[]
): number => {
  // Base score from comprehension level (lower = higher priority)
  const comprehensionScore = {
    none: 4,
    low: 3,
    medium: 2,
    high: 1,
  }[progress.comprehensionLevel || 'none'];
  
  // Recency penalty (older = higher priority)
  const daysSinceStudied = progress.lastStudiedDate
    ? (Date.now() - new Date(progress.lastStudiedDate).getTime()) / (1000 * 60 * 60 * 24)
    : 999;
  const recencyScore = Math.min(daysSinceStudied / 7, 5); // Cap at 5
  
  // Exam urgency (closer deadline = higher priority)
  const relatedExams = examinations.filter((exam) =>
    exam.relatedTopicIds?.includes(topic.id)
  );
  const urgencyScore = relatedExams.length > 0
    ? Math.max(...relatedExams.map((exam) => {
        const daysUntilExam = (new Date(exam.date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        return Math.max(0, 14 - daysUntilExam) / 2; // 0-7 score for exams within 14 days
      }))
    : 0;
  
  // Weak point flag
  const weakPointScore = weakPoints.some((wp) => wp.topicOrSubject === topic.title)
    ? 3
    : 0;
  
  return comprehensionScore + recencyScore + urgencyScore + weakPointScore;
};
```

### Roadmap Generation Prompt Template

```
You are Gus, an AI study advisor for a Computer Science student.

Generate a 30-90 day learning roadmap based on:
- Progress Profile: [summary of comprehension levels, session history]
- Upcoming Examinations: [exam names, dates]
- Weak Points: [student-flagged topics]
- Available Materials: [topic list from KB]

Requirements:
1. Generate 5-10 learning goals covering the next 30-90 days
2. Each goal must have:
   - Clear title
   - Target completion date
   - Brief description of learning objective
   - Related topics from Materials
3. Prioritize:
   - Exam preparation (align with deadlines)
   - Weak point remediation
   - Low-comprehension topics
4. Ensure realistic time distribution across the period

Output format: JSON array of goals.
```
