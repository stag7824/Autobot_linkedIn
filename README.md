# LinkedIn Easy Apply Bot 🤖

An intelligent, modular LinkedIn job application bot that automates Easy Apply applications with AI-powered form filling using Google Gemini.

## ✨ Features

- **🎯 Easy Apply Automation** - Automatically applies to LinkedIn Easy Apply jobs
- **🤖 AI-Powered Form Filling** - Uses Google Gemini to intelligently answer application questions
- **🔍 Smart Job Filtering** - Filter by keywords, experience, location, job type, and more
- **🛡️ Anti-Detection** - Stealth mode, human-like delays, and session breaks
- **📱 Push Notifications** - Real-time notifications via ntfy.sh
- **💾 Persistent State** - Tracks applied jobs, resumes from crashes
- **🐳 Docker Ready** - Easy VPS deployment with Docker
- **⚙️ Highly Configurable** - All settings via environment variables

## 📋 Prerequisites

- Node.js 18+ (or Docker)
- LinkedIn account
- Google Gemini API key (free at [Google AI Studio](https://makersuite.google.com/app/apikey))

## 🚀 Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd linkedin-easy-apply-bot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Required
USER_ID=your_email@example.com
USER_PASSWORD="your_password"
GEMINI_API_KEY="your_gemini_api_key"

# Search Configuration
SEARCH_TERMS=["Software Engineer", "Full Stack Developer"]
SEARCH_LOCATION="United States"

# Personal Information (for applications)
FIRST_NAME="John"
LAST_NAME="Doe"
PHONE_NUMBER="1234567890"
YEARS_OF_EXPERIENCE="3"
```

### 3. Run

```bash
# Non-headless mode (see browser)
npm start

# Or with Docker
docker-compose up -d
```

## ⚙️ Configuration

All configuration is done via environment variables in `.env`. See [.env.example](.env.example) for all options.

### Key Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `USER_ID` | LinkedIn email | Required |
| `USER_PASSWORD` | LinkedIn password | Required |
| `DAILY_LIMIT` | Max applications per day | 100 |
| `SEARCH_TERMS` | JSON array of job titles to search | Required |
| `SEARCH_LOCATION` | Job location | "" (worldwide) |
| `EASY_APPLY_ONLY` | Only apply to Easy Apply jobs | true |
| `COMPLETE_REQUIREMENTS` | Only apply if you meet all requirements | false |
| `HEADLESS` | Run browser in headless mode | false |
| `GEMINI_API_KEY` | Google Gemini API key for AI answering | "" |
| `NTFY_URL` | ntfy.sh URL for push notifications | "" |

### Job Filters

```env
# Experience level filter
EXPERIENCE_LEVEL=["Entry level", "Associate", "Mid-Senior level"]

# Job type filter
JOB_TYPE=["Full-time"]

# Remote/On-site filter
ON_SITE=["Remote", "Hybrid"]

# Skip jobs containing these words
BAD_WORDS=["US Citizen", "Security Clearance", "No Sponsorship"]
```

### Personal Information (for forms)

```env
FIRST_NAME="John"
LAST_NAME="Doe"
PHONE_NUMBER="1234567890"
CURRENT_CITY="New York"
YEARS_OF_EXPERIENCE="3"
REQUIRE_VISA="Yes"
CITIZENSHIP_STATUS="Non-citizen seeking work authorization"
DESIRED_SALARY=90000
```

### AI Configuration

```env
GEMINI_API_KEY="your_api_key"
GEMINI_MODEL="gemini-1.5-flash"

# Complete user profile for AI context
USER_INFO="""
Name: John Doe
Experience: 3 years in software development
Skills: JavaScript, Python, React, Node.js
Education: BS Computer Science
...add all relevant info for AI to use when answering questions...
"""
```

## 🐳 Docker Deployment

### Build and Run

```bash
# Build image
docker build -t linkedin-bot .

# Run with environment file
docker run -d --name linkedin-bot \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  linkedin-bot
```

### Docker Compose

```bash
# Start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## 📁 Project Structure

```
├── src/
│   ├── index.js              # Entry point
│   ├── bot/
│   │   └── LinkedInBot.js    # Main bot class
│   ├── config/
│   │   └── index.js          # Configuration loader
│   ├── services/
│   │   ├── geminiService.js  # AI answering service
│   │   ├── stateManager.js   # Persistence layer
│   │   └── notificationService.js
│   └── utils/
│       └── helpers.js        # Utility functions
├── data/                     # Applied jobs, state, logs
├── .env.example              # Configuration template
├── Dockerfile                # Docker build file
├── docker-compose.yml        # Docker Compose config
└── package.json
```

## 📊 Output Files

The bot creates these files in the `data/` directory:

- `applied_jobs.json` - Record of all applied jobs
- `applied_jobs.csv` - CSV export for easy viewing
- `bot_state.json` - Bot state for resume after crash
- `daily_stats.json` - Daily application statistics
- `error_log.json` - Error log for debugging

## 🔔 Notifications

Set up push notifications using [ntfy.sh](https://ntfy.sh):

1. Choose a unique topic (e.g., `my-linkedin-bot`)
2. Set `NTFY_URL=https://ntfy.sh/my-linkedin-bot` in `.env`
3. Subscribe to the topic on your phone

You'll receive notifications for:
- ✅ Successful applications
- ❌ Failed applications
- 📊 Daily summary
- 🚨 Critical errors

## ⚠️ Important Notes

1. **Use Responsibly** - This tool automates job applications. Use within LinkedIn's terms of service.

2. **Security Verification** - LinkedIn may occasionally require CAPTCHA or email verification. The bot will pause and notify you.

3. **Rate Limiting** - The bot includes anti-detection measures, but avoid running 24/7 or applying to hundreds of jobs per day.

4. **Review Applications** - Set `PAUSE_BEFORE_SUBMIT=true` to review each application before submitting.

5. **Student Visa Users** - Configure `REQUIRE_VISA="Yes"` and set appropriate `CITIZENSHIP_STATUS`.

## 🛠️ Troubleshooting

### Bot can't log in
- Check your email/password in `.env`
- Try logging in manually first to clear any security checks
- Set `HEADLESS=false` to see what's happening

### Navigation timeouts
- The bot has retry logic built in
- Check your internet connection
- Try increasing delays in the code

### AI not answering questions
- Verify your `GEMINI_API_KEY` is valid
- Check the console for API errors
- Ensure `USER_INFO` contains relevant information

### Docker issues
- Make sure Chrome dependencies are installed
- Try rebuilding: `docker-compose build --no-cache`

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

## 🙏 Credits

Inspired by [Auto_job_applier_linkedIn](https://github.com/GodsScion/Auto_job_applier_linkedIn) by Sai Vignesh Golla.

---

**Disclaimer**: This tool is for educational purposes. The authors are not responsible for any misuse or violation of LinkedIn's terms of service.
