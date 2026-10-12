// SF Desk calendar helper: reads the Mac's calendars (the accounts in System Settings > Internet
// Accounts, e.g. Exchange) through EventKit and prints JSON. The server compiles it on first use.
//   sfdesk-calendar calendars
//   sfdesk-calendar events <fromISO> <toISO> <calendarId>[,<calendarId>...]
// macOS asks once for permission to read calendars.

import EventKit
import Foundation

func out(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [])
  FileHandle.standardOutput.write(data)
}
func fail(_ code: String, _ message: String) -> Never {
  out(["error": code, "message": message])
  exit(1)
}

let store = EKEventStore()
let done = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { ok, _ in granted = ok; done.signal() }
} else {
  store.requestAccess(to: .event) { ok, _ in granted = ok; done.signal() }
}
done.wait()
if !granted {
  fail("denied", "SF Desk isn't allowed to read your calendars. In System Settings > Privacy & Security > Calendars, " +
    "allow the app you run SF Desk from (e.g. Terminal), then reload.")
}

let iso = ISO8601DateFormatter()
let day = DateFormatter()
day.dateFormat = "yyyy-MM-dd"
day.locale = Locale(identifier: "en_US_POSIX")

func sourceType(_ t: EKSourceType) -> String {
  switch t {
  case .local: return "local"
  case .exchange: return "exchange"
  case .calDAV: return "caldav"
  case .mobileMe: return "icloud"
  case .subscribed: return "subscribed"
  case .birthdays: return "birthdays"
  @unknown default: return "other"
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage", "usage: sfdesk-calendar calendars | events <from> <to> <ids>") }

if args[1] == "calendars" {
  out(store.calendars(for: .event).map { c in [
    "id": c.calendarIdentifier, "title": c.title, "account": c.source.title,
    "type": sourceType(c.source.sourceType), "writable": c.allowsContentModifications,
  ] as [String: Any] })
  exit(0)
}

guard args[1] == "events", args.count >= 5, let from = iso.date(from: args[2]), let to = iso.date(from: args[3]) else {
  fail("usage", "usage: sfdesk-calendar events <fromISO> <toISO> <calendarIds>")
}
let ids = Set(args[4].split(separator: ",").map(String.init))
let calendars = store.calendars(for: .event).filter { ids.contains($0.calendarIdentifier) }
if calendars.isEmpty { out([]); exit(0) }
let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars))
out(events.map { e -> [String: Any] in
  let attendees: [[String: Any]] = (e.attendees ?? []).map { p in
    let email = p.url.absoluteString.hasPrefix("mailto:") ? String(p.url.absoluteString.dropFirst(7)) : ""
    return ["name": p.name ?? "", "email": email.removingPercentEncoding ?? email, "me": p.isCurrentUser]
  }
  return [
    // Occurrences of a repeating event share an identifier; the server adds the start to tell them apart.
    "uid": e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? "",
    "title": e.title ?? "",
    "start": iso.string(from: e.startDate),
    "end": iso.string(from: e.endDate),
    "date": day.string(from: e.startDate),
    "allDay": e.isAllDay,
    "location": e.location ?? "",
    "notes": e.notes ?? "",
    "calendar": e.calendar.title,
    "calendarId": e.calendar.calendarIdentifier,
    "organizer": e.organizer?.name ?? "",
    "attendees": attendees,
    "canceled": e.status == .canceled,
    "free": e.availability == .free,
  ]
})
