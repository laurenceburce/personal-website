# Portfolio (Next.js)

A clean, responsive personal portfolio built with Next.js (App Router), React, and CSS.

## Stack

- Next.js App Router
- React
- `next/font` for local Google font hosting
- Plain CSS in `app/globals.css`
- Resend (contact email delivery)

## Project structure

- `app/layout.js`: global layout + metadata + font setup
- `app/page.js`: main portfolio page, sidebar interactions, and sidebar contact form
- `app/api/contact/route.js`: form validation + email delivery endpoint
- `app/globals.css`: theme, layout, responsive behavior, and animations

## Run locally

1. Install dependencies:

```powershell
npm install
```

2. Create a local environment file (`.env.local`) with contact email settings:

```env
RESEND_API_KEY=re_your_api_key
RESEND_FROM=Portfolio Contact <onboarding@resend.dev>
CONTACT_TO=your_destination_email@example.com
```

Use a verified sender/domain for `RESEND_FROM` in production. Resend's
`onboarding@resend.dev` sender is useful for initial testing.

For production visitor analytics, connect a MySQL database and add:

```env
DATABASE_URL=mysql://user:password@host:3306/database
ANALYTICS_ADMIN_TOKEN=choose_a_private_admin_token
```

On Railway, set `DATABASE_URL` as a reference variable to
`${{MySQL.MYSQL_URL}}`. The sidebar displays total and unique visit counts.
Visitor emails are stored only after a successful contact form submission and
can be read from the protected `/api/analytics/identified` endpoint using
`Authorization: Bearer ANALYTICS_ADMIN_TOKEN`.

3. Start dev server:

```powershell
npm run dev
```

4. Build for production:

```powershell
npm run build
npm start
```

## Customize quickly

1. Update your name, role, and copy in `app/page.js`.
2. Update sidebar contact form copy/behavior in `app/page.js`.
3. Edit arrays in `app/page.js`:
   - `skills`
   - `projects`
   - `timeline`
4. Adjust colors and spacing in `app/globals.css` under `:root`.

Welcome
About
Work
Education
Skills
Projects

Playground
- chat/voice bot?
- add a sticky notes/freedom wall/chalkboard
- stats: total viewers, unique viewers ()
- financial tracker app

Sketch
- stickers + text modifier (highlights, etc)

Skills
copilot studio
azure deployment tools

List all technologies used
Programming Language
DB (if used)
Frameworks
APIs

add country stat view on main page
make it iphone friendly (icons/emojis)
On an iphone, some of the symbols turn into an emoji. I dont want to use emoji and I want the symbols to be unified (the same) across all platforms. Can we convert these symbols into an image or something that can achieve what I want?

add thesis to github repo and add the repo link in site
Fix the chatbot