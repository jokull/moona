#!/usr/bin/env bun

import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline/promises";

const API = "https://api.noona.is/v1/marketplace";
const TOKEN_PATH = join(homedir(), ".noona-token");

async function loadToken(): Promise<string | null> {
  try {
    return (await Bun.file(TOKEN_PATH).text()).trim();
  } catch {
    return process.env.NOONA_TOKEN ?? null;
  }
}

async function saveToken(token: string) {
  await Bun.write(TOKEN_PATH, token);
}

async function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(message);
  rl.close();
  return answer.trim();
}

async function login() {
  const phoneInput = await prompt("Phone number (e.g. +354 6161339): ");
  const match = phoneInput.match(/^\+?(\d{1,3})\s*(\d+)$/);
  if (!match) {
    console.error("Invalid format. Use: +354 6161339");
    process.exit(1);
  }
  const [, countryCode, phoneNumber] = match;

  // Step 1: Send SMS
  console.log("Sending verification code...");
  const sendRes = await fetch(`${API}/user/verify_phone_number`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      phone_country_code: `+${countryCode}`,
      phone_number: phoneNumber,
    }),
  });

  if (sendRes.status === 429) {
    console.error("Rate limited. Wait a minute and try again.");
    process.exit(1);
  }

  if (!sendRes.ok) {
    console.error("Failed to send SMS:", await sendRes.text());
    process.exit(1);
  }

  // Step 2: Verify OTP
  const otp = await prompt("Enter the SMS code: ");

  const verifyRes = await fetch(`${API}/user/verify_phone_number`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      phone_country_code: `+${countryCode}`,
      phone_number: phoneNumber,
      otp,
    }),
  });

  if (!verifyRes.ok) {
    console.error("Verification failed:", await verifyRes.text());
    process.exit(1);
  }

  const data = await verifyRes.json();
  const token = data.token ?? data.access_token ?? data.jwt;

  if (!token) {
    console.error("No token in response. Full response:", JSON.stringify(data));
    console.error(
      "\nIf this keeps failing, grab your token from the browser:"
    );
    console.error(
      "  Open noona.is DevTools > Network > look for Authorization header"
    );
    console.error(`  Then: echo '<token>' > ${TOKEN_PATH}`);
    process.exit(1);
  }

  await saveToken(token);
  console.log(`  Logged in! Token saved to ${TOKEN_PATH}`);
}

let TOKEN = await loadToken();

// Allow login without a token
if (process.argv[2] === "login") {
  await login();
  process.exit(0);
}

if (!TOKEN) {
  console.error("Not logged in. Run: bun run index.ts login");
  process.exit(1);
}

const headers = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Authorization: TOKEN,
};

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

// --- Types ---

interface Enterprise {
  id: string;
  profile: { name: string; description?: string };
  companies: {
    id: string;
    enterprise_id: string;
    connections: {
      location?: { formatted_address: string };
      min_cancel_notice?: number;
    };
  }[];
}

interface EventType {
  id: string;
  title: string;
  minutes: number;
  description?: string;
  payments: {
    total_payment: number;
    pre_payment_required: boolean;
    pre_payment_amount: number;
    on_location_payment_amount: number;
  };
  connections: { customer_selects?: string };
  variations?: { id: string; label?: string }[];
}

interface TimeSlotDay {
  date: string;
  status?: string;
  slots: { time: string; employeeIds: string[]; spaceIds: string[] }[];
}

// --- Commands ---

async function search(query: string) {
  const params = new URLSearchParams({
    search: query,
    filter: "{}",
    sort: JSON.stringify({ field: "popular", order: "desc" }),
    pagination: JSON.stringify({ limit: 10 }),
  });
  const enterprises: Enterprise[] = await api(`/enterprises?${params}`);

  if (!enterprises.length) {
    console.log("No results.");
    return;
  }

  for (const e of enterprises) {
    const addr =
      e.companies[0]?.connections?.location?.formatted_address ?? "";
    console.log(`  ${e.profile.name}`);
    console.log(`  ID: ${e.id} | Company: ${e.companies[0]?.id}`);
    if (addr) console.log(`  📍 ${addr}`);
    console.log();
  }
}

async function services(companyId: string) {
  const eventTypes: EventType[] = await api(
    `/companies/${companyId}/event_types`
  );

  if (!eventTypes.length) {
    console.log("No services found.");
    return;
  }

  for (const et of eventTypes) {
    const price = et.payments.total_payment;
    const prepay = et.payments.pre_payment_required;
    console.log(`  ${et.title}`);
    console.log(
      `  ID: ${et.id} | ${et.minutes}min | ${price.toLocaleString()} ISK${prepay ? " (prepay required)" : ""}`
    );
    if (et.description) console.log(`  ${et.description}`);
    console.log();
  }
}

async function availability(
  companyId: string,
  eventTypeId: string,
  startDate: string,
  days = 7
) {
  const start = new Date(startDate);
  const end = new Date(start);
  end.setDate(end.getDate() + days);

  const endDate = end.toISOString().split("T")[0];

  const params = new URLSearchParams({
    event_type_ids: eventTypeId,
    start_date: startDate,
    end_date: endDate,
  });

  const slotDays: TimeSlotDay[] = await api(
    `/companies/${companyId}/time_slots?${params}`
  );

  let found = false;
  for (const day of slotDays) {
    if (day.slots.length === 0) continue;
    found = true;
    console.log(`  ${day.date}:`);
    for (const s of day.slots) {
      console.log(`    ${s.time}  (employee: ${s.employeeIds.join(", ")})`);
    }
  }

  if (!found) {
    console.log("No available slots in this range.");
  }
}

async function book(
  companyId: string,
  eventTypeId: string,
  startsAt: string,
  employeeId?: string
) {
  // Check for prepayment
  const eventTypes: EventType[] = await api(
    `/companies/${companyId}/event_types`
  );
  const eventType = eventTypes.find((et) => et.id === eventTypeId);

  if (!eventType) {
    console.error("Event type not found.");
    process.exit(1);
  }

  if (eventType.payments.pre_payment_required) {
    console.error(
      "This service requires prepayment — skipping to avoid charges."
    );
    process.exit(1);
  }

  const user = await api("/user");

  // Step 1: Create time slot reservation
  const reservationBody: Record<string, unknown> = {
    company: companyId,
    event_types: [eventTypeId],
    starts_at: startsAt,
    phone_country_code: user.phone_country_code,
    phone_number: user.phone_number,
  };

  if (employeeId) {
    reservationBody.employee = employeeId;
    reservationBody.specific_employee_requested = true;
  }

  console.log("Creating time slot reservation...");
  const reservation = await api("/time_slot_reservations", {
    method: "POST",
    body: JSON.stringify(reservationBody),
  });

  console.log(`  Reserved: ${reservation.starts_at} → ${reservation.ends_at}`);
  console.log(`  Expires: ${reservation.expires_at}`);

  // Step 2: Create event from reservation
  const eventBody = {
    time_slot_reservation: reservation.id,
    phone_country_code: user.phone_country_code,
    phone_number: user.phone_number,
    customer_name: user.name,
    ssn: user.kennitala ?? "",
    email: user.email,
    origin: "online",
    no_show_acknowledged: true,
    booking_for_other: false,
    booking_questions: [],
  };

  console.log("Confirming booking...");
  const expandParams = new URLSearchParams();
  for (const field of ["company", "employee", "event_type"]) {
    expandParams.append("expand[]", field);
  }
  const event = await api(`/events?${expandParams}`, {
    method: "POST",
    body: JSON.stringify(eventBody),
  });

  const start = new Date(event.starts_at);
  const service = event.event_types?.[0]?.title ?? "Unknown";
  const employeeName = event.employee?.profile?.name ?? "Any";
  console.log(`  Booked: ${service} with ${employeeName}`);
  console.log(
    `  ${start.toLocaleDateString("is-IS")} ${start.toLocaleTimeString("is-IS", { hour: "2-digit", minute: "2-digit" })}`
  );
  console.log(`  Event ID: ${event.id}`);
  console.log(
    `  Payment: ${event.payments?.total_payment?.toLocaleString() ?? "?"} ISK (pay on location)`
  );

  return event;
}

async function cancel(eventId: string) {
  const event = await api(`/events/${eventId}`);
  const service = event.event_types?.[0]?.title ?? "Unknown";
  const start = new Date(event.starts_at);

  await api(`/events/${eventId}`, {
    method: "POST",
    body: JSON.stringify({ status: "cancelled", cancel_reason: "" }),
  });

  console.log(`  Cancelled: ${service}`);
  console.log(
    `  Was: ${start.toLocaleDateString("is-IS")} ${start.toLocaleTimeString("is-IS", { hour: "2-digit", minute: "2-digit" })}`
  );
}

async function bookings() {
  const params = new URLSearchParams({
    filter: JSON.stringify({ from: new Date().toISOString() }),
    sort: JSON.stringify({ field: "starts_at", order: "asc" }),
    pagination: JSON.stringify({ limit: 20 }),
  });
  for (const field of ["company", "employee", "event_type"]) {
    params.append("expand[]", field);
  }

  const events = await api(`/events?${params}`);

  if (!events.length) {
    console.log("No upcoming bookings.");
    return;
  }

  for (const e of events) {
    const start = new Date(e.starts_at);
    const service = e.event_types?.[0]?.title ?? "Unknown";
    const price = e.payments?.total_payment;
    const company = e.company?.profile?.store_name ?? "?";
    const employee = e.employee?.profile?.name ?? "Any";
    const status = e.confirmed ? "confirmed" : "pending";
    console.log(
      `  ${start.toLocaleDateString("is-IS")} ${start.toLocaleTimeString("is-IS", { hour: "2-digit", minute: "2-digit" })} — ${service} @ ${company} (${employee})`
    );
    console.log(
      `  ID: ${e.id} | ${e.duration}min | ${price?.toLocaleString() ?? "?"} ISK | ${status}`
    );
    console.log();
  }
}

async function me() {
  const user = await api("/user");
  console.log(`  ${user.name}`);
  console.log(`  +${user.phone_country_code} ${user.phone_number}`);
  console.log(`  ${user.email}`);
}

// --- CLI ---

const [command, ...args] = process.argv.slice(2);

const HELP = `Usage: bun run index.ts <command> [args]

Commands:
  login                                       Authenticate with phone number + SMS code
  me                                          Show current user
  search <query>                              Search for businesses
  services <company_id>                       List services for a company
  slots <company_id> <event_type_id> [date]   Check availability (default: today, 7 days)
  book <company_id> <event_type_id> <datetime> [employee_id]
                                              Book a slot (ISO datetime, e.g. 2026-03-30T15:30:00Z)
                                              Only books services without prepayment.
  cancel <event_id>                           Cancel a booking
  bookings                                    List upcoming bookings
`;

switch (command) {
  case "me":
    await me();
    break;
  case "search":
    if (!args[0]) {
      console.error("Usage: search <query>");
      process.exit(1);
    }
    await search(args.join(" "));
    break;
  case "services":
    if (!args[0]) {
      console.error("Usage: services <company_id>");
      process.exit(1);
    }
    await services(args[0]);
    break;
  case "slots":
    if (!args[0] || !args[1]) {
      console.error("Usage: slots <company_id> <event_type_id> [start_date]");
      process.exit(1);
    }
    await availability(
      args[0],
      args[1],
      args[2] ?? new Date().toISOString().split("T")[0]
    );
    break;
  case "book":
    if (!args[0] || !args[1] || !args[2]) {
      console.error(
        "Usage: book <company_id> <event_type_id> <starts_at_iso> [employee_id]"
      );
      process.exit(1);
    }
    await book(args[0], args[1], args[2], args[3]);
    break;
  case "cancel":
    if (!args[0]) {
      console.error("Usage: cancel <event_id>");
      process.exit(1);
    }
    await cancel(args[0]);
    break;
  case "bookings":
    await bookings();
    break;
  default:
    console.log(HELP);
}
