/* ============================================================================
 * SEO landing-page generator.
 * Run:  node tools/gen-seo.js
 * Emits one static HTML page per entry in PAGES into public/, and regenerates
 * public/sitemap.xml. Pages share one dark-theme template consistent with the
 * app. All claims about other products are kept factual and generic.
 * ==========================================================================*/
"use strict";
const fs = require("fs");
const path = require("path");

const SITE = "https://samecouch.com";
const OUT = path.join(__dirname, "..", "public");

/* ---- shared fragments ---- */
const COMMON_WHAT = {
  h2: "What is SameCouch?",
  paras: [
    "SameCouch is a private living room in your browser for people who are far apart. You watch YouTube, Vimeo or your own videos in perfect sync, see and hear each other in small floating webcam bubbles, react with emoji, and leave photos and notes on a shared memories wall that's still there the next time you both come back.",
    "There is no app to install and no account to create. You make a room with one click, send the link on WhatsApp, and you're together — usually in under ten seconds."
  ]
};
const FAQ_FREE = { q: "Is SameCouch free?", a: "Yes. Rooms, synced watching, video calling and chat are free. Your shared memories wall stays free for 10 days, and you can extend it for a small fee if you want to keep it longer." };
const FAQ_APP = { q: "Do I need to install anything?", a: "No. It runs in the browser on any phone, tablet or computer — no extension, no app, no sign-up. Just open the link." };
const FAQ_PRIVATE = { q: "Is it private?", a: "Yes. Rooms only exist for people who have the link, the host can set a password, and video/audio go directly between participants with end-to-end encryption." };
const FAQ_PEOPLE = { q: "How many people can join?", a: "Up to 8 people in one room — enough for a whole family evening or a movie night with friends in different countries." };

function altSection(name, points) {
  return [
    { h2: "Why people look for a " + name + " alternative", bullets: points },
    { h2: "How SameCouch is different", bullets: [
      "100% browser-based: no extension, no app download, no account — one link and you're in.",
      "Faces first: small floating webcam bubbles over the video, so you watch each other's reactions, not just the screen.",
      "A room that remembers: photos, notes and clips stay on your shared wall between sessions.",
      "Private by default: rooms are link-only, password-protectable, and video/audio are end-to-end encrypted peer-to-peer.",
      "Works with YouTube, Vimeo, direct video links, your own files and photo albums — playback stays in sync for everyone."
    ]}
  ];
}

/* ---- pages ---- */
const PAGES = [
  /* ---------- alternatives (high intent) ---------- */
  {
    slug: "rave-alternative",
    title: "Rave Alternative in the Browser — No App Needed | SameCouch",
    desc: "Looking for a Rave alternative without installing an app? Watch together in your browser with webcams, perfect sync and a private room. Free, no sign-up.",
    kicker: "No app needed",
    h1: "A Rave alternative that runs in your browser",
    intro: [
      "Rave is a popular watch-together app, but it requires everyone to install it and create an account — and public rooms aren't for everyone.",
      "If you just want a private room with the people you actually know, SameCouch gives you synced watching plus live webcams straight from the browser."
    ],
    sections: [
      ...altSection("Rave", [
        "Everyone has to install the mobile app before they can join.",
        "Accounts and public/social rooms aren't ideal for private family moments.",
        "Older relatives often struggle with app stores and logins."
      ]),
      COMMON_WHAT
    ],
    faq: [FAQ_APP, FAQ_FREE, FAQ_PRIVATE]
  },
  {
    slug: "teleparty-alternative",
    title: "Teleparty Alternative Without a Chrome Extension | SameCouch",
    desc: "A Teleparty (Netflix Party) alternative that needs no browser extension and no streaming subscriptions. Watch YouTube and your own videos together with webcams.",
    kicker: "No extension needed",
    h1: "A Teleparty alternative without the extension",
    intro: [
      "Teleparty (formerly Netflix Party) is great if everyone has the same streaming subscriptions and uses a desktop browser with the extension installed.",
      "But if you want to watch with family on a phone, without subscriptions on both ends, and while actually seeing each other — there's an easier way."
    ],
    sections: [
      ...altSection("Teleparty", [
        "It requires a browser extension, which doesn't work on most mobile browsers.",
        "Everyone needs their own subscription to the same streaming service.",
        "It's built around text chat — seeing and hearing each other isn't the focus."
      ]),
      COMMON_WHAT
    ],
    faq: [FAQ_APP, { q: "Can we watch Netflix on SameCouch?", a: "No — and that's deliberate. SameCouch focuses on YouTube, Vimeo and your own videos and memories, which everyone can watch without paid subscriptions and without legal grey areas." }, FAQ_PEOPLE]
  },
  {
    slug: "watch2gether-alternative",
    title: "Watch2Gether Alternative With Webcams First | SameCouch",
    desc: "A Watch2Gether alternative built around seeing each other: floating webcam bubbles, synced video, a private memories wall. Free and browser-based.",
    kicker: "Faces first",
    h1: "A Watch2Gether alternative built around faces",
    intro: [
      "Watch2Gether is a solid browser-based watch-together site, and like us it works without an account.",
      "The difference is what the product is for. Watch2Gether is built around the video and a chat column. SameCouch is built around the people: your faces float over the video, the room feels like a living room, and what you share stays on your wall for next time."
    ],
    sections: [
      ...altSection("Watch2Gether", [
        "The interface centres on the playlist and text chat rather than webcams.",
        "Rooms feel like a utility page, not a place that's yours.",
        "There's no shared space that remembers your photos and moments between sessions."
      ]),
      COMMON_WHAT
    ],
    faq: [FAQ_FREE, FAQ_PRIVATE, FAQ_PEOPLE]
  },
  {
    slug: "kast-alternative",
    title: "Kast Alternative — Simple, Private, In the Browser | SameCouch",
    desc: "A lightweight Kast alternative: no app, no account, no community servers. Just a private room with synced video and webcams for the people you miss.",
    kicker: "Click and you're in",
    h1: "A Kast alternative without the heavy setup",
    intro: [
      "Kast is built as a social platform: apps, communities, parties with up to a hundred watchers.",
      "If what you actually want is one private room with your partner or your family — not a platform — SameCouch keeps it light: one link, faces over the video, done."
    ],
    sections: [
      ...altSection("Kast", [
        "Desktop/mobile apps and accounts are needed for the full experience.",
        "Features like picture-in-picture webcams sit behind a premium plan.",
        "Community/party features add complexity you may not need for family nights."
      ]),
      COMMON_WHAT
    ],
    faq: [FAQ_APP, FAQ_FREE, FAQ_PRIVATE]
  },
  {
    slug: "scener-alternative",
    title: "Scener Alternative Without Extension or Subscriptions | SameCouch",
    desc: "Scener alternative that works on any device: no Chrome extension, no streaming subscriptions on both ends. Watch together with webcams, free.",
    kicker: "Any device",
    h1: "A Scener alternative that works on any device",
    intro: [
      "Scener pioneered the virtual movie theater for streaming services, using a Chrome extension and your own subscriptions.",
      "SameCouch takes the opposite approach: no extension, no subscriptions needed, works on phones — built for YouTube and the videos and memories you already own."
    ],
    sections: [
      ...altSection("Scener", [
        "It needs a Chrome extension, so phones and tablets are limited.",
        "Everyone usually needs their own streaming subscription.",
        "Theater-style rooms aren't the same as an intimate private room."
      ]),
      COMMON_WHAT
    ],
    faq: [FAQ_APP, FAQ_FREE, FAQ_PEOPLE]
  },
  {
    slug: "kosmi-alternative",
    title: "Kosmi Alternative — A Calmer, More Personal Room | SameCouch",
    desc: "A Kosmi alternative focused on one thing: being together. Synced video, webcam bubbles, and a private wall of memories. No clutter, no sign-up.",
    kicker: "Less platform, more living room",
    h1: "A Kosmi alternative that feels like a living room",
    intro: [
      "Kosmi offers many room types — games, virtual browsers, watch parties — which is great for hangouts.",
      "SameCouch does one thing with care: a private living room where you watch together, see each other's faces, and keep your shared memories. Nothing to configure, nothing to explain to your parents."
    ],
    sections: [
      ...altSection("Kosmi", [
        "Many features and room types make it less obvious for non-technical family members.",
        "The experience is a hangout platform rather than a personal, persistent space.",
        "Memories don't accumulate anywhere between sessions."
      ]),
      COMMON_WHAT
    ],
    faq: [FAQ_APP, FAQ_PRIVATE, FAQ_PEOPLE]
  },
  {
    slug: "discord-watch-together-alternative",
    title: "Discord Watch Together Alternative for Family | SameCouch",
    desc: "Watch videos together without Discord servers, accounts or gamer UI. A private browser room with webcams and synced playback your whole family can open.",
    kicker: "No server setup",
    h1: "Watch together — without needing Discord",
    intro: [
      "Discord's Watch Together activity works well if everyone already lives on Discord.",
      "But for parents and grandparents, a Discord server, accounts and channels are a real barrier. SameCouch is one link in WhatsApp — and they're sitting across from you."
    ],
    sections: [
      ...altSection("Discord Watch Together", [
        "Everyone needs a Discord account and to join your server first.",
        "The interface is built for gamers, which can overwhelm family members.",
        "Activities are tied to the Discord app/ecosystem."
      ]),
      COMMON_WHAT
    ],
    faq: [FAQ_APP, FAQ_FREE, FAQ_PEOPLE]
  },

  /* ---------- use cases ---------- */
  {
    slug: "watch-youtube-together",
    title: "Watch YouTube Together — In Sync, With Webcams | Free",
    desc: "Watch YouTube together with friends or family in perfect sync, while seeing each other on webcam. Free private rooms in the browser, no sign-up.",
    kicker: "Perfect sync",
    h1: "Watch YouTube together, face to face",
    intro: [
      "Paste any YouTube link into your private room and it plays in perfect sync for everyone — when one of you pauses, everyone pauses; when someone skips ahead, everyone follows.",
      "Meanwhile you see and hear each other in floating webcam bubbles over the video, so a music video becomes a conversation and a documentary becomes a night together."
    ],
    sections: [
      { h2: "How it works", bullets: [
        "Create a free private room (one click, no account).",
        "Send the link on WhatsApp — friends join from any phone or computer.",
        "Paste a YouTube link, or search YouTube together right inside the room.",
        "Playback stays in sync automatically; the movie volume even ducks when someone talks."
      ]},
      COMMON_WHAT
    ],
    faq: [FAQ_FREE, FAQ_APP, FAQ_PEOPLE]
  },
  {
    slug: "long-distance-movie-night",
    title: "Long Distance Movie Night — Date Night, Any Distance",
    desc: "Have a real movie night with your long-distance partner: synced video, your faces over the film, emoji reactions and a shared wall of memories. Free.",
    kicker: "For couples apart",
    h1: "Movie night with your long-distance love",
    intro: [
      "The hardest part of long distance isn't the big things — it's the ordinary evenings you don't get to share. Movie night is the easiest one to take back.",
      "Open your room, press play together, and watch each other laugh in the corner of the screen. Afterwards, leave a note or a photo on your wall — it'll be there next date night."
    ],
    sections: [
      { h2: "Make it a ritual", bullets: [
        "Schedule your movie night and you'll both get a reminder.",
        "Keep one fixed room link — it becomes 'your place'.",
        "Save reaction clips of the moments that made you laugh.",
        "Leave notes on the memories wall between dates."
      ]},
      COMMON_WHAT
    ],
    faq: [FAQ_PRIVATE, FAQ_FREE, FAQ_APP]
  },
  {
    slug: "long-distance-date-ideas",
    title: "7 Long Distance Date Ideas You Can Do Tonight",
    desc: "Simple, real long-distance date ideas: synced movie nights, photo evenings, YouTube rabbit holes and more — all in one private browser room. Free.",
    kicker: "Tonight, not someday",
    h1: "Long distance date ideas that actually feel together",
    intro: [
      "Good long-distance dates aren't about elaborate plans — they're about doing one ordinary thing at the same time, while seeing each other's face."
    ],
    sections: [
      { h2: "Seven dates you can have tonight", bullets: [
        "Classic movie night: one YouTube film, synced, faces in the corner.",
        "Photo evening: share the week's photos on your wall and talk through them.",
        "YouTube rabbit hole: take turns queueing videos the other hasn't seen.",
        "Old memories night: re-watch clips and photos from when you were together.",
        "Cook-along: prop up your phones in the kitchen and follow the same recipe video.",
        "Concert night: a full live-concert video, lights off on both ends.",
        "Plan-the-visit night: watch travel videos of where you'll meet next."
      ]},
      COMMON_WHAT
    ],
    faq: [FAQ_FREE, FAQ_APP, FAQ_PRIVATE]
  },
  {
    slug: "watch-videos-with-family-abroad",
    title: "Watch Videos With Family Abroad — One Room, One Evening",
    desc: "Be part of the evening back home: watch videos with your family abroad in sync, see everyone live, and share the kids' photos on a wall that stays.",
    kicker: "For families apart",
    h1: "Spend the evening with your family back home",
    intro: [
      "Millions of people work far from their families — and video calls always end too quickly because there's nothing to do together.",
      "A shared living room changes that: put on a video everyone enjoys, let the call breathe, and just be in the same (virtual) room for an evening. Share photos of the kids on your wall, and they'll still be there next week."
    ],
    sections: [
      { h2: "Made for the distance", bullets: [
        "Up to 8 people — parents, kids, grandparents in one room.",
        "Works on any phone in the browser; no app for anyone to install.",
        "18 languages, including Arabic, Hindi, Urdu, Tagalog, Bengali and Tamil.",
        "The memories wall keeps photos and notes between visits.",
        "The host can set a room password so it stays family-only."
      ]},
      COMMON_WHAT
    ],
    faq: [FAQ_PEOPLE, FAQ_APP, FAQ_FREE]
  },
  {
    slug: "virtual-family-movie-night",
    title: "Virtual Family Movie Night — How to Host One (Free)",
    desc: "Host a virtual family movie night across cities or countries: synced video, everyone's faces on screen, reminders and a shared photo wall. Free guide.",
    kicker: "The whole family",
    h1: "Host a virtual family movie night",
    intro: [
      "Birthdays, Sunday evenings, Eid, Christmas — whenever the family can't all be in one house, a virtual movie night is the next best thing.",
      "Here's the simple recipe we see working for families every week."
    ],
    sections: [
      { h2: "The recipe", bullets: [
        "Pick a time and schedule it in the room — everyone gets a calendar invite or reminder.",
        "Share one room link in the family group chat; it stays the same every week.",
        "Choose something everyone can watch: YouTube has full films, concerts and old shows.",
        "Let the youngest pick the first video — instant engagement.",
        "End with the wall: everyone posts one photo from their week."
      ]},
      COMMON_WHAT
    ],
    faq: [FAQ_PEOPLE, FAQ_FREE, FAQ_PRIVATE]
  },
  {
    slug: "how-to-watch-videos-together-online",
    title: "How to Watch Videos Together Online (2026 Guide)",
    desc: "Every way to watch videos together online in 2026 — extensions, apps and browser rooms — and how to pick the right one for your situation.",
    kicker: "Honest guide",
    h1: "How to watch videos together online",
    intro: [
      "There are three ways to watch in sync with someone far away: browser extensions tied to streaming services, social watch-party apps, and browser-based rooms. Each fits a different situation."
    ],
    sections: [
      { h2: "The three options", bullets: [
        "Extensions (Teleparty, Scener): best if everyone has the same paid streaming subscriptions and watches on desktop.",
        "Apps (Rave, Kast, Hearo): best if your group doesn't mind installing apps and making accounts, and likes public/social rooms.",
        "Browser rooms (SameCouch, Watch2Gether, Kosmi): nothing to install, work on phones, best for private groups, YouTube and your own videos."
      ]},
      { h2: "Our advice", paras: [
        "If your goal is watching a specific paid streaming service, use that service's official party feature or an extension.",
        "If your goal is being together with specific people — a partner, your family abroad — pick a browser room with webcams, so joining takes seconds for the least technical person in your group. That's what SameCouch is built for."
      ]},
      COMMON_WHAT
    ],
    faq: [FAQ_APP, FAQ_FREE, FAQ_PEOPLE]
  },
  {
    slug: "watch-movies-with-friends-online",
    title: "Watch Movies With Friends Online — Free Private Rooms",
    desc: "Bring back movie night with friends who moved away: synced playback, webcams over the movie, emoji reactions and clips. Free, in the browser.",
    kicker: "Bring back movie night",
    h1: "Watch movies with friends, wherever they moved",
    intro: [
      "Friends scatter — to other cities, other countries. The group chat survives, but movie night usually doesn't.",
      "A private room brings it back: same film, same moment, everyone's reactions on screen, and the running commentary that made movie night fun in the first place."
    ],
    sections: [
      { h2: "Built for friend groups", bullets: [
        "Up to 8 friends in one room, from any device.",
        "Emoji reactions rain over the screen; clips capture the best laughs.",
        "Auto-ducking lowers the movie when someone talks — no more 'WAIT what did you say?'",
        "One fixed room link: bookmark it and it's movie night HQ."
      ]},
      COMMON_WHAT
    ],
    faq: [FAQ_PEOPLE, FAQ_FREE, FAQ_APP]
  }
];

/* ---- template ---- */
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function render(p, all) {
  const others = all.filter(x => x.slug !== p.slug);
  const faqLd = {
    "@context": "https://schema.org", "@type": "FAQPage",
    "mainEntity": p.faq.map(f => ({ "@type": "Question", "name": f.q, "acceptedAnswer": { "@type": "Answer", "text": f.a } }))
  };
  const sections = p.sections.map(s => {
    let h = `<h2>${esc(s.h2)}</h2>`;
    if (s.paras) h += s.paras.map(t => `<p>${esc(t)}</p>`).join("");
    if (s.bullets) h += `<ul>` + s.bullets.map(b => `<li>${esc(b)}</li>`).join("") + `</ul>`;
    return h;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.desc)}" />
<link rel="canonical" href="${SITE}/${p.slug}.html" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="SameCouch" />
<meta property="og:title" content="${esc(p.h1)}" />
<meta property="og:description" content="${esc(p.desc)}" />
<meta property="og:url" content="${SITE}/${p.slug}.html" />
<meta property="og:image" content="${SITE}/og.jpg" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>
<style>
  :root{--bg:#0b0a0c;--panel:#161219;--line:rgba(255,255,255,.09);--txt:#efe7dd;--muted:#a59a90;--amber:#f4b14a;--amber2:#ffcf86}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1000px 600px at 50% -100px, rgba(244,177,74,.12), transparent 60%), var(--bg);color:var(--txt);font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.65}
  main{max-width:760px;margin:0 auto;padding:34px 22px 70px;font-size:15.5px}
  .brand{display:flex;align-items:center;gap:9px;text-decoration:none;color:var(--txt);font-weight:700;letter-spacing:.5px}
  .brand .bulb{width:13px;height:13px;border-radius:50%;background:radial-gradient(circle at 35% 30%, #fff3d6, var(--amber) 60%, #b9792a);box-shadow:0 0 10px rgba(244,177,74,.7)}
  .brand i{font-style:normal;color:var(--amber2)}
  .kicker{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--amber);margin:34px 0 8px}
  h1{font-size:clamp(28px,5vw,40px);line-height:1.12;margin:0 0 14px}
  h2{font-size:20px;margin:32px 0 8px;color:var(--amber2)}
  p,li{color:var(--muted)} ul{padding-left:22px} li{margin-bottom:7px}
  .cta{display:inline-block;margin:22px 0 4px;padding:15px 28px;border-radius:13px;background:linear-gradient(180deg,var(--amber2),var(--amber));color:#2a1c06;font-weight:700;font-size:16px;text-decoration:none;box-shadow:0 12px 30px rgba(244,177,74,.25)}
  .cta:hover{filter:brightness(1.05)}
  .ctasub{font-size:12.5px;color:#6f655c;margin-top:6px}
  .faq{border:1px solid var(--line);border-radius:13px;background:rgba(255,255,255,.02);margin-bottom:9px;padding:13px 16px}
  .faq b{display:block;margin-bottom:5px;color:var(--txt)}
  .faq span{color:var(--muted);font-size:14px}
  .more{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .more a{font-size:12.5px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:6px 12px;text-decoration:none}
  .more a:hover{color:var(--amber2);border-color:rgba(244,177,74,.5)}
  footer{margin-top:44px;border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:#6f655c}
  footer a{color:#8a7f74}
</style>
</head>
<body>
<main>
  <a class="brand" href="/"><span class="bulb"></span>Same<i>Couch</i></a>
  <div class="kicker">${esc(p.kicker)}</div>
  <h1>${esc(p.h1)}</h1>
  ${p.intro.map(t => `<p>${esc(t)}</p>`).join("\n  ")}
  <a class="cta" href="/">Create your private room — it's free</a>
  <div class="ctasub">No app · No sign-up · Works on any phone</div>
  ${sections}
  <h2>Frequently asked questions</h2>
  ${p.faq.map(f => `<div class="faq"><b>${esc(f.q)}</b><span>${esc(f.a)}</span></div>`).join("\n  ")}
  <a class="cta" href="/">Start watching together now</a>
  <h2>More ways to be together</h2>
  <div class="more">
    ${others.map(o => `<a href="/${o.slug}.html">${esc(o.h1)}</a>`).join("\n    ")}
  </div>
  <footer><a href="/">SameCouch</a> · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a></footer>
</main>
</body>
</html>
`;
}

/* ---- emit pages ---- */
let written = 0;
for (const p of PAGES) {
  fs.writeFileSync(path.join(OUT, p.slug + ".html"), render(p, PAGES));
  written++;
}

/* ---- sitemap ---- */
const urls = [
  { loc: SITE + "/", pr: "1.0", cf: "weekly" },
  ...PAGES.map(p => ({ loc: `${SITE}/${p.slug}.html`, pr: "0.8", cf: "monthly" })),
  { loc: SITE + "/privacy.html", pr: "0.3", cf: "yearly" },
  { loc: SITE + "/terms.html", pr: "0.3", cf: "yearly" }
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u.loc}</loc><changefreq>${u.cf}</changefreq><priority>${u.pr}</priority></url>`).join("\n") +
  `\n</urlset>\n`;
fs.writeFileSync(path.join(OUT, "sitemap.xml"), sitemap);

console.log(`Wrote ${written} pages + sitemap.xml (${urls.length} URLs).`);
