# Graph Report - .  (2026-04-16)

## Corpus Check
- Corpus is ~31,550 words - fits in a single context window. You may not need a graph.

## Summary
- 263 nodes · 694 edges · 18 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_UI & Navigation|UI & Navigation]]
- [[_COMMUNITY_Auto-Check & Monitoring|Auto-Check & Monitoring]]
- [[_COMMUNITY_Task Management|Task Management]]
- [[_COMMUNITY_Comment Gen Workspace|Comment Gen Workspace]]
- [[_COMMUNITY_Data Fetching & APIs|Data Fetching & APIs]]
- [[_COMMUNITY_External Services (Upvote, Dolphin)|External Services (Upvote, Dolphin)]]
- [[_COMMUNITY_Subreddit Search|Subreddit Search]]
- [[_COMMUNITY_Server Rank Checking|Server Rank Checking]]
- [[_COMMUNITY_Task Board|Task Board]]
- [[_COMMUNITY_Content Creator Titles|Content Creator Titles]]
- [[_COMMUNITY_Keyword Research & Ahrefs|Keyword Research & Ahrefs]]
- [[_COMMUNITY_Content Creator Wizard|Content Creator Wizard]]
- [[_COMMUNITY_Content Creator Body & Refs|Content Creator Body & Refs]]
- [[_COMMUNITY_Team Management|Team Management]]
- [[_COMMUNITY_Activity Log|Activity Log]]
- [[_COMMUNITY_Comment Reply Threading|Comment Reply Threading]]
- [[_COMMUNITY_Delete Operations|Delete Operations]]
- [[_COMMUNITY_Kanban Views|Kanban Views]]

## God Nodes (most connected - your core abstractions)
1. `toast()` - 41 edges
2. `renderDetail()` - 32 edges
3. `updateSub()` - 24 edges
4. `getSub()` - 22 edges
5. `openModal()` - 17 edges
6. `esc()` - 15 edges
7. `autoCheckRank()` - 15 edges
8. `getGeneralTasks()` - 14 edges
9. `openSettings()` - 14 edges
10. `cgBuildSidebar()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `autoCheckRank()` --calls--> `activityAdd()`  [EXTRACTED]
  app.js → app.js  _Bridges community 16 → community 1_
- `toast()` --calls--> `esc()`  [EXTRACTED]
  app.js → app.js  _Bridges community 4 → community 1_
- `renderMoneyComment()` --calls--> `esc()`  [EXTRACTED]
  app.js → app.js  _Bridges community 4 → community 5_
- `cgRenderWorkspace()` --calls--> `esc()`  [EXTRACTED]
  app.js → app.js  _Bridges community 4 → community 3_
- `cgShowReplyTarget()` --calls--> `esc()`  [EXTRACTED]
  app.js → app.js  _Bridges community 4 → community 17_

## Communities

### Community 0 - "UI & Navigation"
Cohesion: 0.06
Nodes (12): cgNewPost(), cgOpenCustomPost(), checkLogin(), fmtNum(), isRecsCollapsed(), openSubreddit(), renderRecommendations(), showRankPanel() (+4 more)

### Community 1 - "Auto-Check & Monitoring"
Cohesion: 0.15
Nodes (36): addRecAsTask(), addTaskLog(), analyzeCompetitors(), autoCheckAllMoneyComments(), autoCheckAllRanks(), autoCheckRank(), autoCheckSubreddit(), checkMoneyCommentPosition() (+28 more)

### Community 2 - "Task Management"
Cohesion: 0.11
Nodes (27): addGeneralTask(), addKeyword(), buildGeneralTasksCard(), checkMonthlyReset(), clearTaskImg(), deleteGeneralTask(), editGeneralTask(), editTask() (+19 more)

### Community 3 - "Comment Gen Workspace"
Cohesion: 0.18
Nodes (25): ccDeleteDraft(), ccInlineSave(), ccMarkPosted(), ccOpenDraft(), ccSaveDraft(), cgAddManual(), cgBuildSidebar(), cgCancelReply() (+17 more)

### Community 4 - "Data Fetching & APIs"
Cohesion: 0.12
Nodes (24): ahrefsFetch(), autoRefreshAll(), ccGenerateBody(), cgEdit(), cgOpenPost(), cleanImgUrl(), esc(), fetchAhrefsData() (+16 more)

### Community 5 - "External Services (Upvote, Dolphin)"
Cohesion: 0.14
Nodes (22): checkOrderStatus(), checkRankWithProxy(), checkUpvoteBalance(), getDfLogin(), getDfPassword(), getDolphinProfiles(), getDolphinToken(), getOrderHistory() (+14 more)

### Community 6 - "Subreddit Search"
Cohesion: 0.15
Nodes (19): getSsSaved(), openSubSearch(), ssCheckRunningSearch(), ssFetch(), ssLoadMore(), ssLog(), ssMarkHasMods(), ssMarkNoMods() (+11 more)

### Community 7 - "Server Rank Checking"
Cohesion: 0.2
Nodes (14): autoRankCheck(), checkGoogleRank(), detectCaptcha(), escMd(), findPostInResults(), httpGet(), httpsRequest(), killChromium() (+6 more)

### Community 8 - "Task Board"
Cohesion: 0.28
Nodes (9): ccFilterTitleRefPosts(), ccGenerateTitles(), ccPickTitle(), ccRemoveTitleRef(), ccRenderStep3(), ccRenderTitleOptions(), ccRenderTitleRefList(), ccRenderTitleRefSelected() (+1 more)

### Community 9 - "Content Creator Titles"
Cohesion: 0.22
Nodes (9): filterAndSortTasks(), gatherAllTasks(), openTaskBoard(), populateTbFilters(), renderTaskBoard(), renderTbKanban(), renderTbList(), setTbView() (+1 more)

### Community 10 - "Keyword Research & Ahrefs"
Cohesion: 0.29
Nodes (7): ccRenderKwTable(), ccRenderStep2(), ccResearchKeywords(), ccToggleKw(), getAhrefsKey(), openUpdateAhrefs(), renderMoneyPosts()

### Community 11 - "Content Creator Wizard"
Cohesion: 0.29
Nodes (7): ccEditDraft(), ccGoStep2(), ccGoStep3(), ccGoStep4(), ccNewDraft(), ccRenderStep1(), ccRenderWizard()

### Community 12 - "Content Creator Body & Refs"
Cohesion: 0.47
Nodes (6): ccFilterRefPosts(), ccRemoveRef(), ccRenderRefList(), ccRenderRefSelected(), ccRenderStep4(), ccToggleRef()

### Community 13 - "Team Management"
Cohesion: 0.5
Nodes (4): addTeamMember(), deleteTeamMember(), openTeamPanel(), renderTeamList()

### Community 14 - "Activity Log"
Cohesion: 0.67
Nodes (3): confirmDelete(), deleteCurrentSubreddit(), deleteMoneyPost()

### Community 15 - "Comment Reply Threading"
Cohesion: 0.67
Nodes (3): renderKanban(), renderSubredditTasks(), setTaskView()

### Community 16 - "Delete Operations"
Cohesion: 0.67
Nodes (3): activityAdd(), activityUpdate(), renderActivity()

### Community 17 - "Kanban Views"
Cohesion: 0.67
Nodes (3): cgReplyTo(), cgReplyToOwn(), cgShowReplyTarget()

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `toast()` connect `Auto-Check & Monitoring` to `UI & Navigation`, `Task Management`, `Comment Gen Workspace`, `Data Fetching & APIs`, `External Services (Upvote, Dolphin)`, `Subreddit Search`, `Task Board`, `Keyword Research & Ahrefs`, `Content Creator Wizard`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `renderDetail()` connect `Auto-Check & Monitoring` to `UI & Navigation`, `Task Management`, `Data Fetching & APIs`, `Keyword Research & Ahrefs`, `Comment Reply Threading`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Why does `getSub()` connect `Auto-Check & Monitoring` to `UI & Navigation`, `Task Management`, `Data Fetching & APIs`, `External Services (Upvote, Dolphin)`, `Keyword Research & Ahrefs`, `Activity Log`, `Comment Reply Threading`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Should `UI & Navigation` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Task Management` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._
- **Should `Data Fetching & APIs` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._
- **Should `External Services (Upvote, Dolphin)` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._