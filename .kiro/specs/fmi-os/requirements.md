# Requirements Document

## Introduction

FMI OS is a desktop operating system–style web application hosted on AWS Amplify, designed for Year 2 Computer Science students at the Faculty of Mathematics and Informatics (UNIBUC). The application provides a complete desktop environment with six primary desktop applications (Materials, Future Examinations, Calendar, Timetable, Stats, Roadmap), a boot animation, voice command support, and an AI agent named Gus. Gus is powered by Amazon Bedrock (Claude) with retrieval-augmented generation over each student's hierarchical Materials folder structure, examination deadlines, timetable constraints, and self-reported weak points. The system applies the 80/20 principle to generate personalized daily learning sessions that maximize study outcomes. The UI features a persistent Taskbar with integrated session start, voice-enabled Gus prompt, and an Account Center for profile management.

## Glossary

- **FMI OS**: The desktop operating system–style web application described in this document.
- **Gus**: The AI agent embedded in FMI OS, powered by Amazon Bedrock (Claude), that guides learning sessions, answers student questions, and searches the Knowledge Base.
- **Student**: A Year 2 Computer Science student at UNIBUC who uses FMI OS as an authenticated user.
- **Desktop Environment**: The main UI canvas of FMI OS, rendered as a virtual desktop with app icons, draggable windows, and a persistent Taskbar.
- **Desktop App**: One of six applications (Materials, Future Examinations, Calendar, Timetable, Stats, Roadmap) that opens in a window-like panel within the Desktop Environment.
- **Materials App**: The hierarchical folder/file management Desktop App where Students organize study materials; serves as the Knowledge Base for Gus.
- **Knowledge Base**: The indexed collection of all files and folders in the Materials App, used by Gus for retrieval-augmented generation.
- **Future Examinations App**: The timeline-based Desktop App displaying upcoming exam deadlines that Gus uses for session prioritization.
- **Calendar App**: The Desktop App displaying the Student's calendar, pulled from an external source via integration.
- **Timetable App**: The Desktop App managing the Student's class schedule, populated via OCR from an uploaded timetable image and manually editable afterward.
- **Stats App**: The Desktop App where Students record grades, notes, and self-reported weak points.
- **Roadmap App**: The Desktop App displaying Gus-generated long-term learning goals tailored to the Student.
- **Boot Animation**: The startup sequence displayed when a Student first opens FMI OS before the Desktop Environment loads.
- **Taskbar**: The persistent bottom bar of the Desktop Environment containing the "Start today's session" button, the "Ask Gus" prompt input with microphone icon, and the Account Center icon.
- **Account Center**: The Start Menu–like panel opened from the Taskbar, providing profile editing, API key management, and logout controls.
- **Learning Session**: A structured, Gus-guided study sequence prioritized by the 80/20 principle, informed by Materials content, Future Examinations deadlines, Timetable constraints, and Stats weak points.
- **Voice Command**: A spoken instruction captured via the Web Speech API or equivalent that triggers "Start today's session" or "Ask Gus" actions.
- **Gus Resource Search**: A Gus feature allowing Students to request specific files or folders from the Materials Knowledge Base using natural language queries.
- **Progress Profile**: The stored record of a Student's completed sessions, interaction history, and comprehension levels per topic.
- **AWS Amplify**: The hosting and backend service platform for FMI OS.
- **Amazon Bedrock**: The AWS managed AI service that runs Claude and provides the Knowledge Base indexing for Gus.

---

## Requirements

### Requirement 1: Student Authentication

**User Story:** As a Student, I want to create an account and log in securely, so that my desktop, materials, and progress are private and personalized.

#### Acceptance Criteria

1. THE Authentication_System SHALL allow a Student to register with a university email address and a password.
2. WHEN a Student submits valid credentials, THE Authentication_System SHALL authenticate the Student and display the Boot_Animation within 3 seconds.
3. IF a Student submits invalid credentials, THEN THE Authentication_System SHALL display a generic error message without revealing which field caused the failure.
4. WHEN a Student's session token expires, THE Authentication_System SHALL redirect the Student to the login screen and preserve the Student's last Desktop_Environment state for restoration after re-authentication.
5. THE Authentication_System SHALL isolate each Student's data so that no Student can access another Student's Materials, Progress_Profile, Future_Examinations, Stats, or Roadmap data.

---

### Requirement 2: Boot Animation

**User Story:** As a Student, I want to see a boot animation when FMI OS loads, so that the experience feels like starting a real operating system.

#### Acceptance Criteria

1. WHEN a Student successfully authenticates, THE Boot_Animation SHALL display a startup sequence before rendering the Desktop_Environment.
2. THE Boot_Animation SHALL complete and transition to the Desktop_Environment within 5 seconds.
3. THE Boot_Animation SHALL be skippable by Student interaction such as pressing a key or clicking the screen.

---

### Requirement 3: Desktop Environment and Window Management

**User Story:** As a Student, I want a desktop interface with draggable app windows and a persistent Taskbar, so that I can organize my workspace like a real desktop operating system.

#### Acceptance Criteria

1. THE Desktop_Environment SHALL render a full-viewport canvas displaying six Desktop_App icons: Materials, Future_Examinations, Calendar, Timetable, Stats, and Roadmap.
2. WHEN a Student double-clicks a Desktop_App icon, THE Desktop_Environment SHALL open the corresponding app in a draggable, resizable window-like panel within the browser viewport.
3. THE Desktop_Environment SHALL allow multiple Desktop_App windows to be open simultaneously, each with independent focus, position, and z-index ordering.
4. WHEN a Student clicks the title bar of a Desktop_App window, THE Desktop_Environment SHALL bring that window to the front and allow the Student to drag the window to a new position.
5. WHEN a Student refreshes the page, THE Desktop_Environment SHALL restore the Student's workspace layout by automatically reopening all previously open Desktop_App windows with their saved positions.
6. THE Desktop_Environment SHALL remain responsive and usable on screen widths of 1024px and above.

---

### Requirement 4: Taskbar

**User Story:** As a Student, I want a persistent Taskbar with quick access to session start, Gus prompt, and account management, so that I can perform core actions without opening additional windows.

#### Acceptance Criteria

1. THE Taskbar SHALL be fixed at the bottom of the Desktop_Environment and remain visible at all times while a Student is authenticated.
2. THE Taskbar SHALL display three controls: a "Start today's session" button, an "Ask Gus" text input field with an adjacent microphone icon, and an Account_Center icon styled as a Start Menu button.
3. WHEN a Student clicks "Start today's session", THE Taskbar SHALL trigger the Learning_Session generation and open the session interface in a Desktop_App window or overlay.
4. WHEN a Student types a question into the "Ask Gus" input field and presses Enter, THE Taskbar SHALL send the question to the Gus_Agent and display the response in a Gus chat window or overlay.
5. WHEN a Student clicks the Account_Center icon, THE Taskbar SHALL open the Account_Center panel displaying profile editing, API key management, and logout controls.

---

### Requirement 5: Voice Commands

**User Story:** As a Student, I want to use voice commands to start sessions or prompt Gus, so that I can interact with FMI OS hands-free.

#### Acceptance Criteria

1. WHEN a Student clicks the microphone icon in the Taskbar "Ask Gus" input field, THE Voice_Command_System SHALL activate the Web Speech API or equivalent and listen for spoken input.
2. WHEN the Voice_Command_System captures a voice phrase, THE Voice_Command_System SHALL transcribe the phrase to text and populate the "Ask Gus" input field with the transcription.
3. THE Voice_Command_System SHALL recognize the spoken phrase "Start today's session" and trigger the Learning_Session generation as if the Student had clicked the "Start today's session" button.
4. IF the Web Speech API is unavailable in the Student's browser, THEN THE Voice_Command_System SHALL disable the microphone icon and display a tooltip indicating that voice commands are not supported.
5. THE Voice_Command_System SHALL provide visual feedback (microphone icon animation or indicator) while listening for voice input.

---

### Requirement 6: Account Center

**User Story:** As a Student, I want an Account Center accessible from the Taskbar, so that I can manage my profile, API key, and logout without leaving the Desktop Environment.

#### Acceptance Criteria

1. WHEN a Student clicks the Account_Center icon in the Taskbar, THE Account_Center SHALL open a panel or window displaying the Student's profile information.
2. THE Account_Center SHALL display the Student's email address and a display name field that the Student can edit and save.
3. THE Account_Center SHALL display an API key management section where the Student can view, regenerate, or delete the Bedrock API key that powers Gus.
4. THE Account_Center SHALL provide a logout button that, when clicked, terminates the Student's session and redirects the Student to the login screen.
5. THE Account_Center SHALL close when the Student clicks outside the panel or presses the Escape key.

---

### Requirement 7: Materials App — Hierarchical Folder Structure and Knowledge Base

**User Story:** As a Student, I want to organize my study materials in a hierarchical folder structure within the Materials app, so that Gus can index and retrieve content based on my folder organization.

#### Acceptance Criteria

1. THE Materials_App SHALL display a hierarchical tree view of folders and files, with a root folder representing the Student's entire Knowledge_Base.
2. THE Materials_App SHALL allow a Student to create new folders at any level of the hierarchy by right-clicking or using a "New Folder" button.
3. THE Materials_App SHALL allow a Student to upload individual files or entire folders via drag-and-drop or a file picker, placing them into the selected folder in the hierarchy.
4. THE Materials_App SHALL accept file uploads in PDF, PPTX, TXT, MD, DOCX, XLSX, and common image formats (PNG, JPG).
5. IF a Student uploads a file exceeding 20 MB or in an unsupported format, THEN THE Materials_App SHALL reject the upload and display an error message stating the allowed formats and size limit.
6. WHEN a Student uploads a file into the Materials_App hierarchy, THE Knowledge_Base_System SHALL trigger Amazon_Bedrock Knowledge Base ingestion for that file within 60 seconds.
7. THE Materials_App SHALL display indexing status (Pending, Indexing, Indexed, Failed) for each uploaded file in the tree view.
8. THE Materials_App SHALL allow a Student to rename, move, or delete files and folders, and propagate deletions to the Knowledge_Base_System within 10 seconds.
9. THE Materials_App SHALL preserve folder hierarchy metadata so that Gus citations include the folder path context (e.g., "Data Structures > Week 3 > Sorting.pdf").

---

### Requirement 8: Gus Resource Search

**User Story:** As a Student, I want to ask Gus to find specific files or folders in my Materials, so that I can quickly locate resources without manually browsing the hierarchy.

#### Acceptance Criteria

1. WHEN a Student submits a natural language query such as "Find my data structures notes from week 3" to the Gus_Agent, THE Gus_Agent SHALL search the Student's Materials_App folder hierarchy and Knowledge_Base metadata for matching files or folders.
2. THE Gus_Agent SHALL return a list of matching resources with folder paths and file names, ranked by relevance to the query.
3. THE Gus_Agent SHALL provide direct links or navigation actions in the response so that clicking a result opens the Materials_App and highlights the selected file or folder.
4. IF no matching resources are found, THEN THE Gus_Agent SHALL inform the Student and suggest alternative search terms or browsing the Materials_App manually.

---

### Requirement 9: Future Examinations App — Deadline Timeline

**User Story:** As a Student, I want to view all my upcoming exam deadlines in a timeline, so that Gus can prioritize session topics based on urgency.

#### Acceptance Criteria

1. THE Future_Examinations_App SHALL display a timeline view of all upcoming examination deadlines, ordered chronologically.
2. THE Future_Examinations_App SHALL allow a Student to add a new examination deadline by providing an exam name, subject, date, and optional notes.
3. THE Future_Examinations_App SHALL allow a Student to edit or delete existing examination deadlines.
4. WHEN the Gus_Agent generates a Learning_Session plan, THE Gus_Agent SHALL query the Future_Examinations_App data and prioritize topics related to examinations with deadlines within the next 14 days.
5. THE Future_Examinations_App SHALL display a visual indicator (color or icon) for examinations within 7 days to highlight urgency.

---

### Requirement 10: Calendar App — External Integration

**User Story:** As a Student, I want to view my calendar inside FMI OS, so that I can see my schedule without leaving the Desktop Environment.

#### Acceptance Criteria

1. THE Calendar_App SHALL display the Student's calendar events pulled from an external source via iframe embed or API integration, persisting cached event data independently of current pull status.
2. WHERE an external calendar API is available, THE Calendar_App SHALL authenticate the Student with the external calendar provider and fetch event data.
3. WHERE an external calendar API is unavailable, THE Calendar_App SHALL embed the calendar webpage in an iframe within the Desktop_App window.
4. THE Calendar_App SHALL refresh calendar data automatically at least once every 15 minutes while the app window is open.
5. IF the external calendar source is unavailable or authentication fails, THEN THE Calendar_App SHALL display an error message and provide a retry button.

---

### Requirement 11: Timetable App — OCR Upload and Manual Editing

**User Story:** As a Student, I want to upload a screenshot of my timetable and have FMI OS extract the schedule automatically, so that Gus can avoid scheduling sessions during class times.

#### Acceptance Criteria

1. THE Timetable_App SHALL allow a Student to upload a timetable image (PNG, JPG, PDF) via drag-and-drop or file picker.
2. WHEN a Student uploads a timetable image, THE Timetable_App SHALL invoke an OCR or vision model (Amazon Textract, Bedrock Vision, or equivalent) to extract class names, days, and time blocks from the image.
3. THE Timetable_App SHALL display the timetable in a weekly grid format with days as columns and time slots as rows.
4. THE Timetable_App SHALL allow a Student to manually add, edit, or delete time blocks in the timetable grid after OCR extraction.
5. WHEN the Gus_Agent generates a Learning_Session plan, THE Gus_Agent SHALL query the Timetable_App data and avoid recommending study times that conflict with scheduled class blocks.
6. THE Timetable_App SHALL persist the Student's timetable data and all manual edits at all times.

---

### Requirement 12: Stats App — Grades and Weak Points

**User Story:** As a Student, I want to record my grades and self-reported weak points, so that Gus can tailor session topics to my areas of struggle.

#### Acceptance Criteria

1. THE Stats_App SHALL allow a Student to enter grades or notes for each subject or exam, organized by course or topic.
2. THE Stats_App SHALL allow a Student to mark specific topics or subjects as weak points using a checkbox, rating scale, or text note.
3. THE Stats_App SHALL display a summary view of the Student's recorded grades and weak points, organized by subject or topic.
4. WHEN the Gus_Agent generates a Learning_Session plan, THE Gus_Agent SHALL query the Stats_App data and prioritize topics marked as weak points by the Student.
5. THE Stats_App SHALL persist all entered data so that refreshing the page does not lose Student input.

---

### Requirement 13: Roadmap App — Gus-Generated Long-Term Goals

**User Story:** As a Student, I want Gus to generate and display long-term learning goals tailored to my progress and deadlines, so that I can see the big picture of my study plan.

#### Acceptance Criteria

1. THE Roadmap_App SHALL display a list or timeline of long-term learning goals generated by the Gus_Agent based on the Student's Progress_Profile, Future_Examinations, Stats weak points, and Materials content.
2. WHEN a Student opens the Roadmap_App for the first time or requests a refresh, THE Gus_Agent SHALL analyze the Student's data and generate a roadmap covering the next 30 to 90 days, retrying until analysis succeeds and displaying no roadmap until the analysis completes.
3. THE Roadmap_App SHALL display each goal with a title, target completion date, and a brief description of the learning objective.
4. THE Roadmap_App SHALL allow a Student to mark a goal as completed, which updates the Student's Progress_Profile.
5. THE Roadmap_App SHALL refresh the roadmap automatically when the Student completes a Learning_Session or updates Future_Examinations deadlines.

---

### Requirement 14: Gus AI Agent — Contextual Q&A with Multi-Source Context

**User Story:** As a Student, I want to ask Gus questions and receive answers that consider my Materials, upcoming exams, timetable, and weak points, so that the guidance is personalized and actionable.

#### Acceptance Criteria

1. WHEN a Student submits a question via the Taskbar "Ask Gus" input or voice command, THE Gus_Agent SHALL generate a response using the Student's Knowledge_Base, Progress_Profile, Future_Examinations deadlines, Timetable constraints, and Stats weak points as context.
2. THE Gus_Agent SHALL return a response to a Student's question within 10 seconds under normal network conditions.
3. IF the Student's Knowledge_Base contains no indexed files, THEN THE Gus_Agent SHALL inform the Student to upload materials in the Materials_App before asking content-specific questions.
4. THE Gus_Agent SHALL cite the specific file and folder path from the Materials_App hierarchy when the answer is grounded in uploaded content.
5. THE Gus_Agent SHALL maintain conversational context within a single session so that the Student does not need to repeat prior context in follow-up questions.
6. IF Amazon_Bedrock returns an error or times out, THEN THE Gus_Agent SHALL display a user-friendly error message with a retry button.

---

### Requirement 15: 80/20 Daily Learning Session with Multi-Source Prioritization

**User Story:** As a Student, I want Gus to generate a daily learning session that focuses on the most impactful 20% of topics, considering my upcoming exams, weak points, and available study time, so that I maximize learning efficiency.

#### Acceptance Criteria

1. WHEN a Student clicks "Start today's session" in the Taskbar, THE Gus_Agent SHALL analyze the Student's Knowledge_Base, Progress_Profile, Future_Examinations deadlines, Stats weak points, and Timetable constraints to identify the highest-yield topics for the current day.
2. WHERE topics related to examinations within 14 days or topics marked as weak points exist, THE Gus_Agent SHALL structure each Learning_Session to cover no more than 20% of the total available topic surface area, prioritizing those high-yield topics.
3. WHEN a Learning_Session is generated, THE Gus_Agent SHALL present a session plan listing selected topics, estimated time per topic, and the rationale for prioritization before starting the session.
4. WHILE a Learning_Session is active, THE Gus_Agent SHALL guide the Student through the selected topics sequentially, providing summaries, key points, and comprehension checks drawn from the Materials_App files.
5. WHEN a Student completes a comprehension check during a Learning_Session, THE Gus_Agent SHALL update the Student's Progress_Profile to reflect the demonstrated understanding.
6. IF a Student exits a Learning_Session before completion, THEN THE Gus_Agent SHALL save progress up to the last completed topic and resume from that point in the next session.
7. THE Gus_Agent SHALL avoid scheduling Learning_Session activities during time blocks marked as class time in the Timetable_App.

---

### Requirement 16: Progress Tracking and Profile Persistence

**User Story:** As a Student, I want my progress, comprehension levels, and session history to be saved automatically, so that Gus can track my improvement over time.

#### Acceptance Criteria

1. THE Progress_Tracking_System SHALL maintain a Progress_Profile for each Student recording each topic studied, the date of last study, and the Student's comprehension level per topic.
2. WHEN a Learning_Session updates the Student's Progress_Profile, THE Progress_Tracking_System SHALL persist the update durably within 5 seconds, retrying on failure and alerting the Student if persistence is delayed beyond the 5-second window.
3. THE Progress_Tracking_System SHALL surface topics with low comprehension or no recent activity as priority candidates to the Gus_Agent when generating the next Learning_Session plan.
4. THE Progress_Tracking_System SHALL allow the Student to view progress history within the Stats_App or a dedicated progress view in the Desktop_Environment.
