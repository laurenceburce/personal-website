export const skillGroups = [
  {
    title: "Programming Languages",
    items: ["Java", "Python", "C/C++", "JavaScript", "TypeScript"]
  },
  {
    title: "Frontend",
    items: ["React"]
  },
  {
    title: "Backend & Frameworks",
    items: ["Spring Boot", "FastAPI", "Oracle ADF", "Oracle SaaS ERP", "REST APIs", "JDBC"]
  },
  {
    title: "Data & Databases",
    items: ["PostgreSQL", "SQL"]
  },
  {
    title: "AI & Automation",
    items: ["Copilot Studio", "Power Platform", "AI Chatbots", "Process Automation"]
  },
  {
    title: "Tools & Systems",
    items: ["Git", "Perforce", "Linux", "Windows"]
  }
];

export const projects = [
  {
    title: "Personal Portfolio Website",
    period: "Apr 2022 – Present",
    description:
      "Designed and built this responsive portfolio with reusable Next.js sections, theme support, a sidebar contact flow, downloadable documents, and an interactive floating toolkit with page annotations, magnifier, calculator, and virtual keyboard tools.",
    tech: ["Next.js", "React", "CSS", "Responsive UI", "Interactive Tools"],
    link: "https://github.com/laurenceburce/personal-website"
  },
  {
    title: "Spring Social Media Blog API",
    period: "Oct 2024 – Dec 2024",
    description:
      "Developed a micro-blogging backend with authentication, registration flows, session management, and scalable data access patterns.",
    tech: ["Spring Boot", "JDBC", "JPA", "REST API"],
    link: "https://github.com/laurenceburce/laurenceburce-pep-spring-project"
  },
  {
    title: "Financial Reports",
    period: "Sep 2022 – Mar 2024",
    association: "Oracle",
    description:
      "Developed tools that present the financial health of the company and communicate key information. Created workbooks and graphical charts to organize data, utilizing advanced accounting features including multicurrency support and report-to-report drill down. Utilized SQL queries and API testing tools to validate data accuracy and synchronization. Collaborated with front-end developers and database administrators to identify and resolve data discrepancies.",
    tech: ["Java", "SQL", "JavaScript", "Windows", "Linux"]
  },
  {
    title: "Soil Quality Monitoring System using Low-Powered Wireless Sensor Network",
    period: "May 2021 – Jan 2022",
    association: "Mapúa University",
    description:
      "Created a low-powered IoT wireless sensor network for monitoring soil quality. Implemented a power management technique utilizing the sleep mode feature of the Wi-Fi module. The system measures soil properties, verifies if values are in the appropriate range, and notifies the user when values are out of range.",
    tech: ["C++", "C#", "C", "SQL", "Windows", "Linux"]
  }
];

export const navItems = [
  { id: "about", href: "#about", label: "About", number: "01", icon: "user" },
  { id: "work", href: "#work", label: "Work Experience", number: "02", icon: "briefcase" },
  { id: "education", href: "#education", label: "Education", number: "03", icon: "cap" },
  { id: "skills", href: "#skills", label: "Skills", number: "04", icon: "spark" },
  { id: "projects", href: "#projects", label: "Projects", number: "05", icon: "briefcase" }
];

export const timeline = [
  {
    company: "Maxx Potential",
    period: "May 2025 - Present",
    logoUrl: "/logos/maxx-potential-logo.png",
    logoClass: "maxx",
    location: "San Diego, US (Remote)",
    website: "https://maxxpotential.com",
    roles: [
      {
        title: "AI & Automation Engineer II",
        period: "May 2025 - Present",
        summary: [
          "Built a brand compliance validation platform using FastAPI and PostgreSQL that automatically reviews social media content for fair housing violations, branding standards, and accessibility issues.",
          "Designed and delivered multiple AI-powered internal tools for HHHunt business units, including HR, Marketing, and Operations, improving process efficiency, data accessibility, and decision-making.",
          "Built and maintained enterprise-grade chatbots and AI agents (e.g., HR knowledge assistants, marketing collateral selectors) using Copilot Studio, Power Platform, JavaScript, Python, and API-based integrations.",
          "Designed a test suite for evaluating AI chatbot accuracy, reducing test runtime by over 90% through concurrent processing."
        ]
      }
    ]
  },
  {
    company: "Oracle",
    period: "March 2022 - March 2024",
    logoUrl: "/logos/oracle-logo.png",
    logoClass: "oracle",
    location: "Metro Manila, PH",
    website: "https://www.oracle.com",
    roles: [
      {
        title: "Associate Software Developer",
        period: "September 2022 - March 2024",
        summary: [
          "Developed and maintained RESTful APIs using Java and Spring Boot for enterprise-level applications.",
          "Increased automated test coverage to at least 80%, ensuring code reliability and performance.",
          "Managed SaaS products leveraging Java, SQL, JavaScript, and tools like GIT and Perforce.",
          "Conducted spike investigations to identify scalable solutions for complex technical problems."
        ]
      },
      {
        title: "Graduate Developer",
        period: "March 2022 - September 2022",
        summary: [
          "Gained proficiency in Oracle ERP and Oracle ADF frameworks through intensive training programs.",
          "Resolved customer-related issues by analyzing SQL databases and StackTraces.",
          "Collaborated in Agile Scrum teams using Jira to track project progress and deliverables.",
          "Delivered key contributions to feature development and successful project rollouts."
        ]
      }
    ]
  },
  {
    company: "Yousource Inc.",
    period: "December 2021 - February 2022",
    logoUrl: "/logos/yousource-logo.png",
    logoClass: "yousource",
    location: "Metro Manila, PH",
    website: "https://www.you-source.com",
    roles: [
      {
        title: "Software Engineer Intern",
        period: "December 2021 - February 2022",
        summary: [
          "Designed and executed QA automation tests to improve software quality.",
          "Documented testing procedures for repeatability and smoother knowledge transfer.",
          "Used C++ and Linux Bash scripting for backend QA tasks."
        ]
      }
    ]
  }
];
