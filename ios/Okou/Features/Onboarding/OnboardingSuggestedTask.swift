import Foundation

/// Role-based first tasks mirror Web; source personalization can replace them until edited.
enum OnboardingSuggestedTask {
  static func prompt(for industry: String?) -> String {
    switch industry {
    case "coaching":
      String(
        localized:
          "Outline a practical training session with learning goals, activities, and a takeaway exercise. Ask me about the learners and topic first."
      )
    case "consulting":
      String(
        localized:
          "Prepare a sourced brief on a prospective client: business, recent developments, and questions for our first meeting. Ask for the company name."
      )
    case "design":
      String(
        localized:
          "Help me write a creative brief with the audience, message, deliverables, and visual direction. Ask me about the project first."
      )
    case "finance":
      String(
        localized:
          "Help me build a month-end close checklist for my bookkeeping work. Ask about the business and reporting needs first."
      )
    case "investing":
      String(
        localized:
          "Prepare a company research brief with the business model, recent public filings, key risks, and dated sources. Ask which company to research."
      )
    case "marketing":
      String(
        localized:
          "Compare the public content of three competitors and suggest three angles for my brand. Ask me which brand and audience to focus on."
      )
    case "operations":
      String(
        localized:
          "Help me plan my week around priorities, deadlines, and meetings. Ask me what matters most and what is already committed."
      )
    case "other":
      String(
        localized:
          "Help me turn a work goal into a practical plan with priorities and next steps. Ask me about the goal, deadline, and constraints."
      )
    case "research":
      String(
        localized:
          "Prepare a research brief with reliable sources, key findings, and open questions. Ask about my topic and what I need to learn."
      )
    case "sales":
      String(
        localized:
          "Research businesses that match my ideal customer and make a shortlist with public sources and reasons for fit. Ask me about my offer and target market."
      )
    case "software":
      String(
        localized:
          "Help me write a feature brief with the user problem, expected behavior, acceptance criteria, and open questions. Ask about the feature first."
      )
    default:
      String(
        localized:
          "Help me turn a work goal into a practical plan with priorities and next steps. Ask me about the goal, deadline, and constraints."
      )
    }
  }
}
