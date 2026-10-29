import type { HalloweenStoredQuestions } from "@okouai/db/jsonb-contracts/halloween";

// Approved sheet 52026, captured October 26, 2026. Each round stores its own immutable copy.
export const HALLOWEEN_QUESTION_BANK = Object.freeze([
  {
    id: "QUIZ-01",
    text: "How do you pronounce Okou?",
    options: [
      {
        id: "A",
        text: "Oh-cow",
        correct: false,
      },
      {
        id: "B",
        text: "Goku",
        correct: false,
      },
      {
        id: "C",
        text: "Oh cool",
        correct: true,
      },
    ],
    explanation:
      "It’s “oh cool.” Like your reaction when your AI teammate gets work done right and fast.",
  },
  {
    id: "QUIZ-02",
    text: "How many petals does Okou’s flower symbol have?",
    options: [
      {
        id: "A",
        text: "Six",
        correct: false,
      },
      {
        id: "B",
        text: "Eight",
        correct: true,
      },
      {
        id: "C",
        text: "Petals? Isn’t it just a circle?",
        correct: false,
      },
    ],
    explanation:
      "Eight petals around an open middle. It’s a flower, not a gear in costume.",
  },
  {
    id: "QUIZ-03",
    text: "Before Okou took over, who was on the team?",
    options: [
      {
        id: "A",
        text: "Zero",
        correct: true,
      },
      {
        id: "B",
        text: "Siri",
        correct: false,
      },
      {
        id: "C",
        text: "Alexander",
        correct: false,
      },
    ],
    explanation:
      "Zero is taking a well-earned break. Okou is here to carry the work forward.",
  },
  {
    id: "QUIZ-04",
    text: "Halloween or not, what’s Okou’s real job?",
    options: [
      {
        id: "A",
        text: "Making mischief",
        correct: false,
      },
      {
        id: "B",
        text: "Making it rain candy",
        correct: false,
      },
      {
        id: "C",
        text: "Being your all-around AI teammate",
        correct: true,
      },
    ],
    explanation:
      "Come on—research, decks, websites… she’s got more than one trick up her sleeve.",
  },
  {
    id: "QUIZ-05",
    text: "Give Okou a job. What does she do?",
    options: [
      {
        id: "A",
        text: "Just gives you advice",
        correct: false,
      },
      {
        id: "B",
        text: "Plans the steps and gets to work",
        correct: true,
      },
      {
        id: "C",
        text: "Ghosts you until next Halloween",
        correct: false,
      },
    ],
    explanation:
      "Tell Okou what you want, get what you need. She puts your connected tools to work.",
  },
  {
    id: "QUIZ-06",
    text: "What’s Okou’s motto for a team buried in work?",
    options: [
      {
        id: "A",
        text: "More done. Same team.",
        correct: true,
      },
      {
        id: "B",
        text: "More meetings. More to-dos.",
        correct: false,
      },
      {
        id: "C",
        text: "Same work. Same chaos.",
        correct: false,
      },
    ],
    explanation: "More done. Same team. Less busywork.",
  },
  {
    id: "QUIZ-07",
    text: "Do you need to code to brief Okou?",
    options: [
      {
        id: "A",
        text: "Yes—go write some code!",
        correct: false,
      },
      {
        id: "B",
        text: "[Okou is out of the office. Back after Halloween.]",
        correct: false,
      },
      {
        id: "C",
        text: "No—just describe your idea",
        correct: true,
      },
    ],
    explanation:
      "Brief Okou in plain language. Simple as that—no AI expertise needed.",
  },
  {
    id: "QUIZ-08",
    text: "Does Okou “fall asleep” when you close your laptop?",
    options: [
      {
        id: "A",
        text: "Yes—she turns into a pumpkin",
        correct: false,
      },
      {
        id: "B",
        text: "Nooo—she can keep working in the cloud",
        correct: true,
      },
      {
        id: "C",
        text: "Better keep that laptop open",
        correct: false,
      },
    ],
    explanation: "Your laptop can rest. Okou’s work runs in the cloud.",
  },
  {
    id: "QUIZ-09",
    text: "A long research job is running. Can Okou take another task?",
    options: [
      {
        id: "A",
        text: "Of course—tasks can run in parallel",
        correct: true,
      },
      {
        id: "B",
        text: "No—ask again next Halloween",
        correct: false,
      },
      {
        id: "C",
        text: "No—she doesn’t have that many “hands”",
        correct: false,
      },
    ],
    explanation: "Another task? Bring it on. Okou can go waaaaay beyond that.",
  },
  {
    id: "QUIZ-10",
    text: "Why refine a spooky brief in the same Okou chat?",
    options: [
      {
        id: "A",
        text: "New chats attract mischievous ghosts",
        correct: false,
      },
      {
        id: "B",
        text: "It’s just a habit",
        correct: false,
      },
      {
        id: "C",
        text: "It keeps the earlier context",
        correct: true,
      },
    ],
    explanation:
      "Earlier messages, results, and corrections stay in context. Less retelling of the same story.",
  },
  {
    id: "QUIZ-11",
    text: "What does a shared Okou agent give your team?",
    options: [
      {
        id: "A",
        text: "Yet another team meeting",
        correct: false,
      },
      {
        id: "B",
        text: "A common role and instructions",
        correct: true,
      },
      {
        id: "C",
        text: "Another “code” to memorize",
        correct: false,
      },
    ],
    explanation:
      "Same hat, same job. Shared instructions keep everyone on the same page.",
  },
  {
    id: "QUIZ-12",
    text: "A process worked like magic. How do you make it reusable?",
    options: [
      {
        id: "A",
        text: "Save it as an Okou Workflow",
        correct: true,
      },
      {
        id: "B",
        text: "Start from scratch every time",
        correct: false,
      },
      {
        id: "C",
        text: "Trust your post-Halloween memory",
        correct: false,
      },
    ],
    explanation:
      "Save the reviewed method as a Workflow—a reusable SOP your team can run again.",
  },
  {
    id: "QUIZ-13",
    text: "What’s the easiest way to automate an Okou workflow?",
    options: [
      {
        id: "A",
        text: "Write your own scheduling code",
        correct: false,
      },
      {
        id: "B",
        text: "Set an alarm and run it yourself",
        correct: false,
      },
      {
        id: "C",
        text: "Just ask Okou to set it up",
        correct: true,
      },
    ],
    explanation:
      "Tell Okou when it should run. She sets up the trigger—no scheduling code needed.",
  },
  {
    id: "QUIZ-14",
    text: "What’s the easiest way to build a workflow with Okou?",
    options: [
      {
        id: "A",
        text: "Build it all in a flowchart",
        correct: false,
      },
      {
        id: "B",
        text: "Tell Okou the steps in plain language",
        correct: true,
      },
      {
        id: "C",
        text: "Book a meeting with IT first",
        correct: false,
      },
    ],
    explanation:
      "Describe it, review the proposed steps, then save the version you agree on.",
  },
  {
    id: "QUIZ-15",
    text: "You write a report every Monday morning. How can Okou help?",
    options: [
      {
        id: "A",
        text: "A scheduled Automation",
        correct: true,
      },
      {
        id: "B",
        text: "A permanent Monday cancellation",
        correct: false,
      },
      {
        id: "C",
        text: "Yet another Monday meeting",
        correct: false,
      },
    ],
    explanation:
      "Set it once. Okou runs the workflow automatically—no need to “summon” her every time.",
  },
  {
    id: "QUIZ-16",
    text: "Besides a schedule, what can wake an Okou Automation?",
    options: [
      {
        id: "A",
        text: "Adding URGENT to the workflow name",
        correct: false,
      },
      {
        id: "B",
        text: "Leaving your laptop open overnight",
        correct: false,
      },
      {
        id: "C",
        text: "A matching email in a connected inbox",
        correct: true,
      },
    ],
    explanation:
      "Emails, calendar events, or a finished run can start a configured workflow.",
  },
  {
    id: "QUIZ-17",
    text: "You save a fix to a shared Okou workflow. Who can use it?",
    options: [
      {
        id: "A",
        text: "Only you—you’re the boss",
        correct: false,
      },
      {
        id: "B",
        text: "Anyone with access to the workflow",
        correct: true,
      },
      {
        id: "C",
        text: "Just you and the admin",
        correct: false,
      },
    ],
    explanation:
      "Save the fix once. Anyone with access to the workflow can use the updated version.",
  },
  {
    id: "QUIZ-18",
    text: "An Okou automation fails. What record can you check?",
    options: [
      {
        id: "A",
        text: "The run log",
        correct: true,
      },
      {
        id: "B",
        text: "None—failed runs disappear",
        correct: false,
      },
      {
        id: "C",
        text: "No idea… maybe a retry will work?",
        correct: false,
      },
    ],
    explanation:
      "The run stops and keeps its log, so you can see which step went wrong.",
  },
  {
    id: "QUIZ-19",
    text: "Which Okou section keeps your finished creations together?",
    options: [
      {
        id: "A",
        text: "Artifacts",
        correct: true,
      },
      {
        id: "B",
        text: "Workflows",
        correct: false,
      },
      {
        id: "C",
        text: "Templates",
        correct: false,
      },
    ],
    explanation:
      "Decks, websites, images, and files—all in one place: Artifacts.",
  },
  {
    id: "QUIZ-20",
    text: "Ask Okou for a Halloween pitch deck. What can she build?",
    options: [
      {
        id: "A",
        text: "Only a blank slide template",
        correct: false,
      },
      {
        id: "B",
        text: "A written and designed deck",
        correct: true,
      },
      {
        id: "C",
        text: "Only tips for making it yourself",
        correct: false,
      },
    ],
    explanation:
      "The blank deck is history. Okou is your all-around AI teammate.",
  },
  {
    id: "QUIZ-21",
    text: "What can Okou export your Halloween deck as?",
    options: [
      {
        id: "A",
        text: "Only screenshots of the slides",
        correct: false,
      },
      {
        id: "B",
        text: "Only a text outline",
        correct: false,
      },
      {
        id: "C",
        text: "An editable PowerPoint file (.pptx)",
        correct: true,
      },
    ],
    explanation: "An editable PowerPoint deck? Okou won’t let you down.",
  },
  {
    id: "QUIZ-22",
    text: "Who can see your new private Okou files by default?",
    options: [
      {
        id: "A",
        text: "Only you",
        correct: true,
      },
      {
        id: "B",
        text: "Your whole team",
        correct: false,
      },
      {
        id: "C",
        text: "Anyone with the link",
        correct: false,
      },
    ],
    explanation: "Private by default. Use Share to choose who gets access.",
  },
  {
    id: "QUIZ-23",
    text: "A slide image has too much text. Easiest fix?",
    options: [
      {
        id: "A",
        text: "Retype the whole thing yourself",
        correct: false,
      },
      {
        id: "B",
        text: "Ask Okou. Easy.",
        correct: true,
      },
      {
        id: "C",
        text: "Leave it—it’s just an image",
        correct: false,
      },
    ],
    explanation:
      "Upload the image. Okou will rebuild it as an editable slide. Then revise it in chat.",
  },
  {
    id: "QUIZ-24",
    text: "Want your brand’s colors in your Halloween deck? How can Okou help?",
    options: [
      {
        id: "A",
        text: "She can’t—only her default style",
        correct: false,
      },
      {
        id: "B",
        text: "No... Only if you restyle every slide",
        correct: false,
      },
      {
        id: "C",
        text: "Just share your brand file or Figma link",
        correct: true,
      },
    ],
    explanation:
      "Send Okou your brand file or Figma link. She’ll take care of the styling.",
  },
  {
    id: "QUIZ-25",
    text: "Need a Halloween illustration? What can Okou create for you?",
    options: [
      {
        id: "A",
        text: "A custom illustration",
        correct: true,
      },
      {
        id: "B",
        text: "Only links to stock-image sites",
        correct: false,
      },
      {
        id: "C",
        text: "Only a written image description",
        correct: false,
      },
    ],
    explanation:
      "Describe the subject and style. Okou creates an illustration for your idea.",
  },
  {
    id: "QUIZ-26",
    text: "Need a matching set of Halloween illustrations? What can Okou create for you?",
    options: [
      {
        id: "A",
        text: "Only a single illustration",
        correct: false,
      },
      {
        id: "B",
        text: "A whole set in the same style",
        correct: true,
      },
      {
        id: "C",
        text: "Only a mood board for you to follow",
        correct: false,
      },
    ],
    explanation: "A matching series? Piece of cake for Okou.",
  },
  {
    id: "QUIZ-27",
    text: "Have a Halloween image you like? What can Okou create for you?",
    options: [
      {
        id: "A",
        text: "Only a description of the image",
        correct: false,
      },
      {
        id: "B",
        text: "Only a copy of the original",
        correct: false,
      },
      {
        id: "C",
        text: "A new illustration using it as a reference",
        correct: true,
      },
    ],
    explanation:
      "Send the reference image and describe the result you want. Okou can work from it.",
  },
  {
    id: "QUIZ-28",
    text: "When Okou makes an image, what do you get?",
    options: [
      {
        id: "A",
        text: "A preview and a downloadable file",
        correct: true,
      },
      {
        id: "B",
        text: "Only a preview",
        correct: false,
      },
      {
        id: "C",
        text: "Only a text description",
        correct: false,
      },
    ],
    explanation:
      "Preview the image, then download it to use wherever you need it.",
  },
  {
    id: "QUIZ-29",
    text: "What can Okou put in your spooky campaign report?",
    options: [
      {
        id: "A",
        text: "Only the written analysis",
        correct: false,
      },
      {
        id: "B",
        text: "Analysis, tables, charts, and layout",
        correct: true,
      },
      {
        id: "C",
        text: "Only charts and tables",
        correct: false,
      },
    ],
    explanation:
      "Analysis, charts, and a polished layout—Okou brings the whole report together.",
  },
  {
    id: "QUIZ-30",
    text: "New data just came in. Can Okou update your existing report?",
    options: [
      {
        id: "A",
        text: "No—you have to rebuild it each time",
        correct: false,
      },
      {
        id: "B",
        text: "Only if you edit every number yourself",
        correct: false,
      },
      {
        id: "C",
        text: "Yes—ask her to update it with the new data",
        correct: true,
      },
    ],
    explanation:
      "Give Okou the new data or use a connected source. She can update the report without you rebuilding it by hand.",
  },
  {
    id: "QUIZ-31",
    text: "How can others view your Okou Halloween report?",
    options: [
      {
        id: "A",
        text: "Open the shared link",
        correct: true,
      },
      {
        id: "B",
        text: "Borrow your laptop—no other way",
        correct: false,
      },
      {
        id: "C",
        text: "Install a special app first",
        correct: false,
      },
    ],
    explanation:
      "Share the link with access enabled. They can open the report right in their browser.",
  },
  {
    id: "QUIZ-32",
    text: "Your Halloween launch needs a site. What can Okou deliver?",
    options: [
      {
        id: "A",
        text: "Only a design mockup",
        correct: false,
      },
      {
        id: "B",
        text: "A finished site with a shareable link",
        correct: true,
      },
      {
        id: "C",
        text: "Only the website copy",
        correct: false,
      },
    ],
    explanation:
      "From copy to design to a live link—Okou gets your site ready for visitors.",
  },
  {
    id: "QUIZ-33",
    text: "Someone opens your Okou site on a phone. What do they see?",
    options: [
      {
        id: "A",
        text: "Tiny text. Hope they brought a magnifier.",
        correct: false,
      },
      {
        id: "B",
        text: "A giant page. Swipe, swipe, swipe.",
        correct: false,
      },
      {
        id: "C",
        text: "A layout that fits their screen",
        correct: true,
      },
    ],
    explanation: "Phone or laptop, Okou adapts the layout to fit the screen.",
  },
  {
    id: "QUIZ-34",
    text: "Can Okou turn the report she made into a presentation?",
    options: [
      {
        id: "A",
        text: "Nope. Time to copy and paste.",
        correct: false,
      },
      {
        id: "B",
        text: "Only if you switch to another tool",
        correct: false,
      },
      {
        id: "C",
        text: "Yes—just ask her to make it a deck",
        correct: true,
      },
    ],
    explanation: "Say “Turn this report into a deck.”",
  },
  {
    id: "QUIZ-35",
    text: "How do you summon Okou in a Slack thread?",
    options: [
      {
        id: "A",
        text: "@ her",
        correct: true,
      },
      {
        id: "B",
        text: "Yell at her",
        correct: false,
      },
      {
        id: "C",
        text: "Stare at her",
        correct: false,
      },
    ],
    explanation:
      "Type @Okou where your team is talking. That’s your summoning spell.",
  },
  {
    id: "QUIZ-36",
    text: "Where can you find Okou in Slack?",
    options: [
      {
        id: "A",
        text: "Only in a channel—no DMs allowed",
        correct: false,
      },
      {
        id: "B",
        text: "In a channel or a DM",
        correct: true,
      },
      {
        id: "C",
        text: "Nowhere. She’s web-only.",
        correct: false,
      },
    ],
    explanation:
      "@Okou in a channel for teamwork, or DM her to work on a draft privately!",
  },
  {
    id: "QUIZ-37",
    text: "A long Okou run started in Slack. Where else can you see the full process?",
    options: [
      {
        id: "A",
        text: "Nowhere—it stays in Slack",
        correct: false,
      },
      {
        id: "B",
        text: "On the web, but only if you start over",
        correct: false,
      },
      {
        id: "C",
        text: "The same thread is on the web, too",
        correct: true,
      },
    ],
    explanation:
      "Open Okou on the web. The same thread keeps the full run log and files together.",
  },
  {
    id: "QUIZ-38",
    text: "How does Okou connect to your work apps?",
    options: [
      {
        id: "A",
        text: "Through connectors, of course",
        correct: true,
      },
      {
        id: "B",
        text: "She already has access to every app",
        correct: false,
      },
      {
        id: "C",
        text: "Just by knowing the app names",
        correct: false,
      },
    ],
    explanation: "4,000+ connectors now in Okou!!!",
  },
  {
    id: "QUIZ-39",
    text: "Who controls your Okou’s permissions?",
    options: [
      {
        id: "A",
        text: "Your teammates",
        correct: false,
      },
      {
        id: "B",
        text: "You",
        correct: true,
      },
      {
        id: "C",
        text: "Okou herself",
        correct: false,
      },
    ],
    explanation:
      "Choose what Okou can access and for how long. You’re in control.",
  },
  {
    id: "QUIZ-40",
    text: "Your teammate runs a workflow you shared. Whose connected apps does it use?",
    options: [
      {
        id: "A",
        text: "Yours",
        correct: false,
      },
      {
        id: "B",
        text: "Everyone’s",
        correct: false,
      },
      {
        id: "C",
        text: "Your teammate’s",
        correct: true,
      },
    ],
    explanation:
      "Share the workflow, not your account access. Everyone uses their own permissions—keep yours private.",
  },
  {
    id: "QUIZ-41",
    text: "Your team’s tool isn’t in Okou’s connector list. Is that game over?",
    options: [
      {
        id: "A",
        text: "Not yet—try a custom connector",
        correct: true,
      },
      {
        id: "B",
        text: "Yep. No listing, no chance.",
        correct: false,
      },
      {
        id: "C",
        text: "Yep. Time to switch tools.",
        correct: false,
      },
    ],
    explanation:
      "If the tool has an API, a custom connector may bring it into Okou—even an internal tool.",
  },
  {
    id: "QUIZ-42",
    text: "You found a bug that’s scarier than Halloween. How can Okou help track it?",
    options: [
      {
        id: "A",
        text: "Just explain what a bug is",
        correct: false,
      },
      {
        id: "B",
        text: "File a GitHub issue with the details",
        correct: true,
      },
      {
        id: "C",
        text: "“Turn it off and on”",
        correct: false,
      },
    ],
    explanation:
      "With your approval, Okou can file the GitHub issue. While you’re there, give Okou a star!",
  },
  {
    id: "QUIZ-43",
    text: "Your sales pipeline is a ghost town. Which Okou result gives you new prospects to evaluate?",
    options: [
      {
        id: "A",
        text: "Suggest search keywords",
        correct: false,
      },
      {
        id: "B",
        text: "Sort a list you already have",
        correct: false,
      },
      {
        id: "C",
        text: "Find matching prospects with sources",
        correct: true,
      },
    ],
    explanation:
      "Describe your ideal customer. How many you want, how many you get.",
  },
  {
    id: "QUIZ-44",
    text: "You need to track each collab contact’s status and next step. What should you ask Okou to create?",
    options: [
      {
        id: "A",
        text: "A Google Sheets tracker",
        correct: true,
      },
      {
        id: "B",
        text: "A contact list with names only",
        correct: false,
      },
      {
        id: "C",
        text: "A one-time follow-up reminder",
        correct: false,
      },
    ],
    explanation:
      "Share the latest updates. Okou can keep everything together in one Google Sheet!",
  },
  {
    id: "QUIZ-45",
    text: "Okou drafts your collab email. Who gets the final say before it’s sent?",
    options: [
      {
        id: "A",
        text: "Okou—it goes out as soon as she’s done",
        correct: false,
      },
      {
        id: "B",
        text: "You—you review it and hit Send",
        correct: true,
      },
      {
        id: "C",
        text: "Your team admin—every draft needs approval",
        correct: false,
      },
    ],
    explanation:
      "Okou won’t send this email without your say-so. You get the final call.",
  },
  {
    id: "QUIZ-46",
    text: "Looking for extra Okou credits? Where are the reward tasks?",
    options: [
      {
        id: "A",
        text: "In the template menu",
        correct: false,
      },
      {
        id: "B",
        text: "In Artifacts, next to your files",
        correct: false,
      },
      {
        id: "C",
        text: "Under Get more credits",
        correct: true,
      },
    ],
    explanation:
      "Click Get more credits at the top right of chat to see your available tasks and requirements.",
  },
  {
    id: "QUIZ-47",
    text: "Want Okou to get your work style? What helps most?",
    options: [
      {
        id: "A",
        text: "Just tell her—she’ll get the idea",
        correct: true,
      },
      {
        id: "B",
        text: "She should know everything, even if you say nothing",
        correct: false,
      },
      {
        id: "C",
        text: "Truth or dare?",
        correct: false,
      },
    ],
    explanation: "Just tell Okou. She’s here to be your best AI teammate.",
  },
  {
    id: "QUIZ-48",
    text: "An AI sounds confident. Is that proof it’s right?",
    options: [
      {
        id: "A",
        text: "Yes—confidence means accuracy",
        correct: false,
      },
      {
        id: "B",
        text: "No—check the evidence",
        correct: true,
      },
      {
        id: "C",
        text: "Yes, if the answer is long enough",
        correct: false,
      },
    ],
    explanation:
      "Confidence isn’t evidence. Okou can help you check sources and separate facts from assumptions.",
  },
  {
    id: "QUIZ-49",
    text: "“Okou, how much did we sell?” What should she do without the sales data?",
    options: [
      {
        id: "A",
        text: "Pick a number that sounds right",
        correct: false,
      },
      {
        id: "B",
        text: "Say “A lot!” and call it a day",
        correct: false,
      },
      {
        id: "C",
        text: "Ask for the sales data first",
        correct: true,
      },
    ],
    explanation:
      "First the data, then the answer. Okou will ask for what’s missing, not invent it.",
  },
  {
    id: "QUIZ-50",
    text: "Your boss wants a Halloween campaign plan “by yesterday.” How can Okou help?",
    options: [
      {
        id: "A",
        text: "Draft the plan",
        correct: true,
      },
      {
        id: "B",
        text: "Schedule a retrospective",
        correct: false,
      },
      {
        id: "C",
        text: "“You got this.”",
        correct: false,
      },
    ],
    explanation:
      "Skip the blank-page panic. Give Okou the brief and let her do the research and writing—you review the plan.",
  },
  {
    id: "QUIZ-51",
    text: "With Okou handling the work, what’s your role?",
    options: [
      {
        id: "A",
        text: "Chief Copy-Paste Officer",
        correct: false,
      },
      {
        id: "B",
        text: "The decision-maker—you call the shots",
        correct: true,
      },
      {
        id: "C",
        text: "Full-time progress-bar watcher",
        correct: false,
      },
    ],
    explanation:
      "You set the direction. Okou helps get the work done. Still your team, still your call.",
  },
  {
    id: "QUIZ-52",
    text: "What do you type in Okou’s chat box to open the template menu? (Hardest question. No pressure.)",
    options: [
      {
        id: "A",
        text: "/",
        correct: true,
      },
      {
        id: "B",
        text: "@",
        correct: false,
      },
      {
        id: "C",
        text: "#",
        correct: false,
      },
    ],
    explanation: "OMG, you actually got it! You’re a true Okou pro.",
  },
  {
    id: "QUIZ-53",
    text: "Do you like Okou?",
    options: [
      {
        id: "A",
        text: "Of course.",
        correct: true,
      },
      {
        id: "B",
        text: "You bet.",
        correct: true,
      },
      {
        id: "C",
        text: "More than candy.",
        correct: true,
      },
    ],
    explanation: "Oh cool. She likes you too!",
  },
] satisfies HalloweenStoredQuestions);
