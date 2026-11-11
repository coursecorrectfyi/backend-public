/**
 * Topics seed — idempotent upsert of the two-level topic hierarchy.
 *
 * Inserts ~17 top-level domains and ~120 subtopics derived from the skills
 * frequency distribution across 20k+ courses in the catalogue.
 *
 * Safe to re-run: uses ON CONFLICT (slug) DO UPDATE to keep data current.
 *
 * Usage:
 *   npm run topics:seed
 *
 * Env vars:
 *   DATABASE_URL — postgres connection string (required)
 */

import 'dotenv/config'
import { eq, isNull } from 'drizzle-orm'
import { db, closeDb } from '../client.js'
import { topics } from '../schema.js'

interface SubtopicSeed {
  name: string
  slug: string
  description: string
  meta_description: string
  sort_order: number
}

interface DomainSeed {
  name: string
  slug: string
  description: string
  meta_description: string
  sort_order: number
  subtopics: SubtopicSeed[]
}

const DOMAINS: DomainSeed[] = [
  {
    name: 'Data & Analytics',
    slug: 'data-analytics',
    description: 'Learn to collect, analyse, and communicate insights from data. Covers everything from spreadsheet fundamentals to advanced BI tools and statistical modelling.',
    meta_description: 'Browse top-rated data and analytics courses. Master data analysis, visualisation, business intelligence, and statistical modelling skills.',
    sort_order: 1,
    subtopics: [
      { name: 'Data Analysis', slug: 'data-analysis', description: 'Techniques for exploring, cleaning, and interpreting datasets to support business decisions.', meta_description: 'Find the best data analysis courses. Learn to clean, explore, and interpret data using Python, Excel, and SQL.', sort_order: 1 },
      { name: 'Data Visualization', slug: 'data-visualization', description: 'Tools and principles for turning raw data into charts, dashboards, and interactive reports.', meta_description: 'Learn data visualization with Tableau, Power BI, and Python. Build dashboards and communicate insights visually.', sort_order: 2 },
      { name: 'Business Intelligence', slug: 'business-intelligence', description: 'BI platforms, KPI design, and reporting workflows that drive organizational decision-making.', meta_description: 'Master business intelligence tools and techniques. Build reports, KPI dashboards, and data-driven decision frameworks.', sort_order: 3 },
      { name: 'Statistical Analysis', slug: 'statistical-analysis', description: 'Probability, hypothesis testing, regression, and statistical inference for data-driven conclusions.', meta_description: 'Learn statistical analysis for data science. Covers probability, hypothesis testing, regression, and inference.', sort_order: 4 },
      { name: 'Exploratory Data Analysis', slug: 'exploratory-data-analysis', description: 'Techniques for summarizing and visualizing datasets to uncover patterns before formal modelling.', meta_description: 'Master exploratory data analysis. Learn to profile datasets, detect outliers, and discover patterns with Python and R.', sort_order: 5 },
      { name: 'Predictive Modeling', slug: 'predictive-modeling', description: 'Building and evaluating statistical and ML models that forecast future outcomes.', meta_description: 'Learn predictive modeling techniques. Build forecasting and classification models using Python, R, and ML frameworks.', sort_order: 6 },
      { name: 'Big Data', slug: 'big-data', description: 'Distributed processing frameworks and architectures for datasets too large for single-machine analysis.', meta_description: 'Learn big data technologies. Master Spark, Hadoop, and distributed computing for large-scale data processing.', sort_order: 7 },
      { name: 'Data Governance', slug: 'data-governance', description: 'Policies, standards, and processes that ensure data quality, lineage, and regulatory compliance.', meta_description: 'Learn data governance frameworks. Cover data quality, cataloguing, lineage, and compliance best practices.', sort_order: 8 },
    ],
  },
  {
    name: 'AI & Machine Learning',
    slug: 'ai-machine-learning',
    description: 'From foundational ML theory to cutting-edge generative AI. Build, evaluate, and deploy intelligent systems across a range of real-world applications.',
    meta_description: 'Explore top AI and machine learning courses. Cover neural networks, deep learning, generative AI, NLP, and responsible AI practices.',
    sort_order: 2,
    subtopics: [
      { name: 'Machine Learning', slug: 'machine-learning', description: 'Core ML algorithms — regression, classification, clustering, and ensemble methods — with hands-on implementation.', meta_description: 'Learn machine learning from scratch. Master supervised, unsupervised, and reinforcement learning with Python and scikit-learn.', sort_order: 1 },
      { name: 'Deep Learning', slug: 'deep-learning', description: 'Neural network architectures including CNNs, RNNs, and transformers built with frameworks like TensorFlow and PyTorch.', meta_description: 'Master deep learning. Build and train neural networks with TensorFlow and PyTorch for vision, NLP, and more.', sort_order: 2 },
      { name: 'Generative AI', slug: 'generative-ai', description: 'Techniques behind large language models, diffusion models, and multimodal AI systems for content generation.', meta_description: 'Learn generative AI. Explore LLMs, diffusion models, and multimodal systems powering modern AI applications.', sort_order: 3 },
      { name: 'Natural Language Processing', slug: 'natural-language-processing', description: 'Methods for text classification, entity recognition, summarization, translation, and building NLP pipelines.', meta_description: 'Learn natural language processing. Build NLP pipelines for text classification, summarization, and language understanding.', sort_order: 4 },
      { name: 'Prompt Engineering', slug: 'prompt-engineering', description: 'Techniques for designing effective prompts and workflows that maximize the utility of large language models.', meta_description: 'Learn prompt engineering for LLMs. Master prompting strategies, chain-of-thought, and RAG to build reliable AI workflows.', sort_order: 5 },
      { name: 'Responsible AI', slug: 'responsible-ai', description: 'Ethics, fairness, transparency, and governance frameworks for building trustworthy AI systems.', meta_description: 'Learn responsible AI principles. Cover bias, fairness, explainability, and governance for ethical AI development.', sort_order: 6 },
      { name: 'Model Evaluation & Deployment', slug: 'model-evaluation-deployment', description: 'Metrics, testing strategies, and MLOps patterns for validating and serving models in production.', meta_description: 'Learn ML model evaluation and deployment. Cover metrics, A/B testing, MLOps, and serving models at scale.', sort_order: 7 },
      { name: 'Computer Vision', slug: 'computer-vision', description: 'Image recognition, object detection, segmentation, and video understanding using deep learning.', meta_description: 'Learn computer vision with deep learning. Build image classification, object detection, and segmentation models.', sort_order: 8 },
    ],
  },
  {
    name: 'Software Development',
    slug: 'software-development',
    description: 'Core programming languages, CS fundamentals, and engineering practices that underpin professional software development across all domains.',
    meta_description: 'Find top software development courses. Learn Python, Java, C#, algorithms, OOP, and professional engineering practices.',
    sort_order: 3,
    subtopics: [
      { name: 'Python', slug: 'python', description: 'Python programming from syntax basics to advanced patterns used in data science, automation, and backend development.', meta_description: 'Learn Python programming. Covers syntax, OOP, libraries, and real-world applications in data, automation, and web.', sort_order: 1 },
      { name: 'JavaScript', slug: 'javascript', description: 'The language of the web — covering ES6+, async patterns, and JS fundamentals for both browser and server environments.', meta_description: 'Learn JavaScript from beginner to advanced. Cover ES6+, async/await, DOM manipulation, and modern JS patterns.', sort_order: 2 },
      { name: 'Java', slug: 'java', description: 'Java language fundamentals, OOP, concurrency, and enterprise patterns used in backend and Android development.', meta_description: 'Learn Java programming. Master OOP, collections, concurrency, and enterprise Java patterns for backend and mobile.', sort_order: 3 },
      { name: 'C# & .NET', slug: 'csharp-dotnet', description: 'C# language features and the .NET ecosystem for building Windows, web, and cross-platform applications.', meta_description: 'Learn C# and .NET development. Build desktop, web, and cloud applications with Microsoft\'s C# ecosystem.', sort_order: 4 },
      { name: 'Algorithms & Data Structures', slug: 'algorithms-data-structures', description: 'Sorting, searching, graphs, trees, dynamic programming, and complexity analysis for technical interviews and system design.', meta_description: 'Master algorithms and data structures. Essential for coding interviews, system design, and writing efficient software.', sort_order: 5 },
      { name: 'Object-Oriented Programming', slug: 'object-oriented-programming', description: 'Encapsulation, inheritance, polymorphism, and SOLID principles applied across languages and design patterns.', meta_description: 'Learn object-oriented programming. Master OOP principles, design patterns, and SOLID for clean, maintainable code.', sort_order: 6 },
      { name: 'Software Architecture', slug: 'software-architecture', description: 'System design patterns, architectural styles (monolith, microservices, event-driven), and scalability trade-offs.', meta_description: 'Learn software architecture and system design. Cover architectural patterns, scalability, and high-level design decisions.', sort_order: 7 },
      { name: 'Git & Version Control', slug: 'git-version-control', description: 'Git workflows, branching strategies, code review, and collaboration practices for professional software teams.', meta_description: 'Learn Git and version control. Master branching, merging, pull requests, and team collaboration workflows.', sort_order: 8 },
    ],
  },
  {
    name: 'Web Development',
    slug: 'web-development',
    description: 'Build modern web applications from front to back. Covers HTML/CSS foundations, popular frameworks, and full-stack patterns used in production.',
    meta_description: 'Browse top web development courses. Learn HTML, CSS, React, Angular, Node.js, and full-stack development.',
    sort_order: 4,
    subtopics: [
      { name: 'HTML & CSS', slug: 'html-css', description: 'Web standards, semantic markup, responsive layouts, and modern CSS techniques including flexbox and grid.', meta_description: 'Learn HTML and CSS fundamentals. Build responsive, accessible web pages with modern layout and styling techniques.', sort_order: 1 },
      { name: 'React', slug: 'react', description: 'Component-based UI development with React, hooks, state management, and the broader React ecosystem.', meta_description: 'Learn React for building modern UIs. Master components, hooks, state management, and the React ecosystem.', sort_order: 2 },
      { name: 'Angular', slug: 'angular', description: 'Google\'s full-featured framework for building enterprise-scale single-page applications with TypeScript.', meta_description: 'Learn Angular for enterprise web development. Cover components, services, routing, and TypeScript integration.', sort_order: 3 },
      { name: 'Node.js', slug: 'nodejs', description: 'Server-side JavaScript with Node.js — event loop, Express, REST APIs, and async I/O patterns.', meta_description: 'Learn Node.js for server-side development. Build REST APIs, handle async I/O, and create scalable backend services.', sort_order: 4 },
      { name: 'WordPress', slug: 'wordpress', description: 'Building, customizing, and managing websites using WordPress themes, plugins, and the block editor.', meta_description: 'Learn WordPress development. Build and customize websites with themes, plugins, and the Gutenberg block editor.', sort_order: 5 },
      { name: 'Web Design', slug: 'web-design', description: 'Visual design principles, typography, color theory, and UX patterns applied to creating effective web experiences.', meta_description: 'Learn web design principles. Cover visual hierarchy, typography, color, and UX patterns for great web experiences.', sort_order: 6 },
      { name: 'Full-Stack Development', slug: 'full-stack-development', description: 'End-to-end web development combining frontend, backend, database, and deployment into cohesive applications.', meta_description: 'Learn full-stack web development. Build complete applications combining frontend, backend, databases, and deployment.', sort_order: 7 },
      { name: 'REST APIs', slug: 'rest-apis', description: 'Designing, building, and consuming RESTful APIs — authentication, versioning, and OpenAPI documentation.', meta_description: 'Learn to build and consume REST APIs. Cover API design, authentication, versioning, and API documentation standards.', sort_order: 8 },
    ],
  },
  {
    name: 'Data Engineering',
    slug: 'data-engineering',
    description: 'Design and maintain the pipelines, databases, and infrastructure that make data reliable and accessible for analytics and AI at scale.',
    meta_description: 'Explore data engineering courses. Learn SQL, data pipelines, ETL, database design, and cloud data warehousing.',
    sort_order: 5,
    subtopics: [
      { name: 'SQL', slug: 'sql', description: 'Querying, aggregation, window functions, and query optimization across relational database systems.', meta_description: 'Learn SQL from basics to advanced. Master querying, joins, window functions, and query optimization techniques.', sort_order: 1 },
      { name: 'Relational Databases', slug: 'relational-databases', description: 'Relational model theory, normalization, transactions, and working with PostgreSQL, MySQL, and other RDBMS.', meta_description: 'Learn relational databases. Cover the relational model, normalization, transactions, and database administration.', sort_order: 2 },
      { name: 'Data Pipelines', slug: 'data-pipelines', description: 'Batch and streaming pipeline architectures using tools like Apache Airflow, Kafka, and Spark.', meta_description: 'Learn to build data pipelines. Cover batch and streaming architectures with Airflow, Kafka, Spark, and dbt.', sort_order: 3 },
      { name: 'ETL & Data Integration', slug: 'etl-data-integration', description: 'Extracting, transforming, and loading data across systems — tools, patterns, and data quality considerations.', meta_description: 'Learn ETL and data integration. Build reliable data workflows that move and transform data across systems.', sort_order: 4 },
      { name: 'Data Modeling', slug: 'data-modeling', description: 'Conceptual, logical, and physical data models — dimensional modelling, star schemas, and data vault.', meta_description: 'Learn data modeling for analytics. Cover dimensional modeling, star schemas, and data warehouse design patterns.', sort_order: 5 },
      { name: 'Database Design', slug: 'database-design', description: 'Schema design, indexing strategies, query planning, and performance tuning for production databases.', meta_description: 'Learn database design and optimization. Master schema design, indexing, query planning, and performance tuning.', sort_order: 6 },
      { name: 'Cloud Data Warehousing', slug: 'cloud-data-warehousing', description: 'Managed warehouse platforms — BigQuery, Snowflake, Redshift — and the analytics engineering patterns built on them.', meta_description: 'Learn cloud data warehousing. Master BigQuery, Snowflake, and Redshift for scalable analytics at cloud scale.', sort_order: 7 },
    ],
  },
  {
    name: 'Cloud Computing',
    slug: 'cloud-computing',
    description: 'Deploy and operate applications on the major cloud platforms. Covers infrastructure, managed services, cost optimization, and cloud-native architecture.',
    meta_description: 'Find top cloud computing courses. Learn AWS, Google Cloud, Azure, cloud architecture, and serverless computing.',
    sort_order: 6,
    subtopics: [
      { name: 'AWS', slug: 'aws', description: 'Amazon Web Services — core services, certification prep, and building production architectures on AWS.', meta_description: 'Learn AWS cloud services. Covers EC2, S3, Lambda, RDS, and AWS certification preparation paths.', sort_order: 1 },
      { name: 'Google Cloud Platform', slug: 'google-cloud-platform', description: 'GCP services including Compute Engine, BigQuery, Cloud Run, and Vertex AI for building on Google infrastructure.', meta_description: 'Learn Google Cloud Platform. Master GCP services including Compute Engine, BigQuery, Cloud Run, and Vertex AI.', sort_order: 2 },
      { name: 'Microsoft Azure', slug: 'microsoft-azure', description: 'Azure services, architecture patterns, and certification prep for building enterprise workloads on Microsoft cloud.', meta_description: 'Learn Microsoft Azure cloud computing. Covers Azure VMs, storage, networking, and Azure certification preparation.', sort_order: 3 },
      { name: 'Cloud Architecture', slug: 'cloud-architecture', description: 'Designing resilient, scalable, and cost-effective systems using cloud-native patterns and the Well-Architected Framework.', meta_description: 'Learn cloud architecture design. Cover multi-region, high availability, and cost-optimized cloud system design.', sort_order: 4 },
      { name: 'Serverless Computing', slug: 'serverless-computing', description: 'Event-driven applications using Functions-as-a-Service and serverless platforms like AWS Lambda and Cloud Functions.', meta_description: 'Learn serverless computing. Build event-driven applications with AWS Lambda, Cloud Functions, and serverless frameworks.', sort_order: 5 },
      { name: 'Cloud Storage', slug: 'cloud-storage', description: 'Object storage, block storage, managed databases, and data transfer patterns on cloud platforms.', meta_description: 'Learn cloud storage solutions. Cover object storage, managed databases, and data transfer across cloud providers.', sort_order: 6 },
      { name: 'Cloud Networking', slug: 'cloud-networking', description: 'VPCs, load balancers, DNS, CDN, and secure network topology design within and across cloud providers.', meta_description: 'Learn cloud networking. Master VPCs, load balancers, CDN, and secure network design across cloud platforms.', sort_order: 7 },
    ],
  },
  {
    name: 'DevOps & Platform Engineering',
    slug: 'devops',
    description: 'Practices and tools that close the gap between development and operations — automation, containers, CI/CD, and observability for reliable software delivery.',
    meta_description: 'Learn DevOps and platform engineering. Master Docker, Kubernetes, CI/CD, Linux, and infrastructure automation.',
    sort_order: 7,
    subtopics: [
      { name: 'Docker', slug: 'docker', description: 'Containerizing applications — Dockerfile authoring, image optimization, multi-stage builds, and Docker Compose.', meta_description: 'Learn Docker containerization. Build, optimize, and compose containers for consistent development and deployment.', sort_order: 1 },
      { name: 'Kubernetes', slug: 'kubernetes', description: 'Orchestrating containerized workloads — deployments, services, Helm charts, and cluster operations.', meta_description: 'Learn Kubernetes container orchestration. Deploy, scale, and manage containerized applications in production clusters.', sort_order: 2 },
      { name: 'CI/CD', slug: 'ci-cd', description: 'Automated build, test, and deployment pipelines using GitHub Actions, Jenkins, GitLab CI, and similar tools.', meta_description: 'Learn CI/CD pipeline automation. Build automated testing and deployment pipelines with GitHub Actions and more.', sort_order: 3 },
      { name: 'Linux', slug: 'linux', description: 'Linux command line, shell scripting, file systems, process management, and system administration fundamentals.', meta_description: 'Learn Linux for developers and sysadmins. Master the command line, shell scripting, and Linux system fundamentals.', sort_order: 4 },
      { name: 'Scripting & Automation', slug: 'scripting-automation', description: 'Bash, Python, and PowerShell scripting to automate repetitive infrastructure and deployment tasks.', meta_description: 'Learn scripting and automation. Use Bash, Python, and PowerShell to automate infrastructure and deployment tasks.', sort_order: 5 },
      { name: 'Infrastructure as Code', slug: 'infrastructure-as-code', description: 'Terraform, Ansible, and Pulumi for provisioning and managing infrastructure declaratively through code.', meta_description: 'Learn infrastructure as code. Provision and manage cloud resources declaratively with Terraform, Ansible, and Pulumi.', sort_order: 6 },
      { name: 'System Monitoring', slug: 'system-monitoring', description: 'Observability stacks — metrics, logging, tracing, alerting — using Prometheus, Grafana, and OpenTelemetry.', meta_description: 'Learn system monitoring and observability. Set up metrics, logging, tracing, and alerting for production systems.', sort_order: 7 },
      { name: 'Microservices', slug: 'microservices', description: 'Decomposing applications into services — service discovery, API gateways, inter-service communication, and resilience patterns.', meta_description: 'Learn microservices architecture. Design, deploy, and operate distributed service-based applications at scale.', sort_order: 8 },
    ],
  },
  {
    name: 'Cybersecurity',
    slug: 'cybersecurity',
    description: 'Protect systems, networks, and data from threats. Covers offensive and defensive security, compliance, and the tools used by security professionals.',
    meta_description: 'Browse top cybersecurity courses. Learn network security, ethical hacking, cryptography, and security compliance.',
    sort_order: 8,
    subtopics: [
      { name: 'Network Security', slug: 'network-security', description: 'Firewalls, intrusion detection, VPNs, and securing network infrastructure against attacks.', meta_description: 'Learn network security fundamentals. Cover firewalls, intrusion detection, VPNs, and network attack defence.', sort_order: 1 },
      { name: 'Application Security', slug: 'application-security', description: 'Secure coding practices, OWASP Top 10, static analysis, and securing web and API applications.', meta_description: 'Learn application security. Master secure coding, OWASP Top 10, and techniques for securing web applications and APIs.', sort_order: 2 },
      { name: 'Cryptography & Encryption', slug: 'cryptography-encryption', description: 'Symmetric and asymmetric encryption, hashing, PKI, TLS, and applied cryptographic protocols.', meta_description: 'Learn cryptography and encryption. Cover symmetric/asymmetric encryption, TLS, PKI, and applied cryptographic protocols.', sort_order: 3 },
      { name: 'Identity & Access Management', slug: 'identity-access-management', description: 'Authentication protocols, OAuth/OIDC, SSO, MFA, and role-based access control across enterprise systems.', meta_description: 'Learn identity and access management. Master OAuth, OIDC, SSO, MFA, and enterprise IAM architecture.', sort_order: 4 },
      { name: 'Penetration Testing', slug: 'penetration-testing', description: 'Ethical hacking methodology, reconnaissance, exploitation, post-exploitation, and writing pentest reports.', meta_description: 'Learn penetration testing and ethical hacking. Master recon, exploitation, and reporting for authorized security assessments.', sort_order: 5 },
      { name: 'Incident Response', slug: 'incident-response', description: 'Detection, containment, eradication, and recovery procedures for handling security incidents and breaches.', meta_description: 'Learn incident response and digital forensics. Cover detection, containment, and recovery from security incidents.', sort_order: 6 },
      { name: 'Threat Detection', slug: 'threat-detection', description: 'SIEM platforms, threat intelligence, behavioural analytics, and hunting for adversarial activity.', meta_description: 'Learn threat detection and security operations. Use SIEM, threat intelligence, and analytics to identify attacks early.', sort_order: 7 },
      { name: 'Risk & Compliance', slug: 'risk-compliance', description: 'Security frameworks (NIST, ISO 27001, SOC 2), risk assessment, audit preparation, and regulatory requirements.', meta_description: 'Learn security risk and compliance. Cover NIST, ISO 27001, SOC 2, and risk assessment frameworks for organizations.', sort_order: 8 },
    ],
  },
  {
    name: 'Mobile Development',
    slug: 'mobile-development',
    description: 'Build native and cross-platform mobile apps for iOS and Android. Covers platform SDKs, cross-platform frameworks, and app store deployment.',
    meta_description: 'Find top mobile development courses. Learn Android, iOS, React Native, and Flutter for building mobile applications.',
    sort_order: 9,
    subtopics: [
      { name: 'Android Development', slug: 'android-development', description: 'Building Android apps with Kotlin or Java — Jetpack Compose, architecture patterns, and Google Play deployment.', meta_description: 'Learn Android app development. Build native Android apps with Kotlin, Jetpack Compose, and the Android SDK.', sort_order: 1 },
      { name: 'iOS Development', slug: 'ios-development', description: 'Building iOS and macOS apps with Swift and SwiftUI — UIKit, Combine, and App Store submission.', meta_description: 'Learn iOS app development. Build native iPhone and iPad apps with Swift, SwiftUI, and the Apple ecosystem.', sort_order: 2 },
      { name: 'React Native', slug: 'react-native', description: 'Cross-platform mobile development with React Native — sharing code between iOS and Android using JavaScript.', meta_description: 'Learn React Native for cross-platform mobile apps. Build iOS and Android apps from a single JavaScript codebase.', sort_order: 3 },
      { name: 'Flutter', slug: 'flutter', description: 'Google\'s UI toolkit for building natively compiled apps for mobile, web, and desktop from a single Dart codebase.', meta_description: 'Learn Flutter app development. Build beautiful, natively compiled apps for mobile, web, and desktop with Dart.', sort_order: 4 },
      { name: 'Mobile UI/UX', slug: 'mobile-ui-ux', description: 'Designing intuitive mobile interfaces — platform conventions, gesture patterns, and accessibility on small screens.', meta_description: 'Learn mobile UI/UX design. Create intuitive mobile experiences following iOS and Android design conventions.', sort_order: 5 },
      { name: 'App Deployment', slug: 'app-deployment', description: 'App signing, release management, CI for mobile, and submitting to the Apple App Store and Google Play.', meta_description: 'Learn mobile app deployment. Cover app signing, release management, and publishing to the App Store and Google Play.', sort_order: 6 },
    ],
  },
  {
    name: 'Design & Creative',
    slug: 'design-creative',
    description: 'Visual design, motion, 3D, and interactive media. Covers both the artistic and technical skills used by designers, animators, and game developers.',
    meta_description: 'Explore design and creative courses. Learn graphic design, UI/UX, 3D modeling, animation, and game development.',
    sort_order: 10,
    subtopics: [
      { name: 'Graphic Design', slug: 'graphic-design', description: 'Visual communication principles, typography, branding, and tools like Photoshop, Illustrator, and Figma.', meta_description: 'Learn graphic design. Master visual communication, typography, and design tools like Photoshop and Illustrator.', sort_order: 1 },
      { name: 'UI/UX Design', slug: 'ui-ux-design', description: 'User research, wireframing, prototyping, and designing digital interfaces that are usable and accessible.', meta_description: 'Learn UI/UX design. Cover user research, wireframing, prototyping, and designing effective digital experiences.', sort_order: 2 },
      { name: '3D Modeling', slug: '3d-modeling', description: 'Creating 3D assets in Blender, Maya, or Cinema 4D — modelling, texturing, rigging, and rendering.', meta_description: 'Learn 3D modeling and rendering. Create 3D assets with Blender, Maya, and Cinema 4D for games, film, and visualization.', sort_order: 3 },
      { name: 'Animation', slug: 'animation', description: '2D and 3D animation principles, motion graphics, rigging, and keyframing for film, games, and web.', meta_description: 'Learn animation and motion design. Cover 2D/3D animation, motion graphics, and keyframing across creative media.', sort_order: 4 },
      { name: 'Video Production', slug: 'video-production', description: 'Filming, editing, colour grading, and post-production workflows using Premiere Pro, DaVinci Resolve, and After Effects.', meta_description: 'Learn video production and editing. Master filming, editing, and post-production using Premiere Pro and DaVinci Resolve.', sort_order: 5 },
      { name: 'Game Development', slug: 'game-development', description: 'Building games with Unity and Unreal Engine — gameplay programming, level design, physics, and publishing.', meta_description: 'Learn game development. Build 2D and 3D games with Unity and Unreal Engine, from gameplay to publishing.', sort_order: 6 },
      { name: 'Prototyping', slug: 'prototyping', description: 'Rapid wireframing and interactive prototyping in Figma, Adobe XD, and similar tools to validate design ideas.', meta_description: 'Learn design prototyping. Create interactive wireframes and prototypes in Figma and Adobe XD to test design concepts.', sort_order: 7 },
    ],
  },
  {
    name: 'Business & Management',
    slug: 'business-management',
    description: 'Leadership, strategy, and operational skills for managers and executives. Covers project management methodologies, business analysis, and organizational change.',
    meta_description: 'Browse business and management courses. Learn project management, leadership, strategic planning, and business analysis.',
    sort_order: 11,
    subtopics: [
      { name: 'Project Management', slug: 'project-management', description: 'Agile, Scrum, PMP, and PRINCE2 methodologies for planning, executing, and delivering projects on time.', meta_description: 'Learn project management methodologies. Prepare for PMP certification and master Agile, Scrum, and PRINCE2 frameworks.', sort_order: 1 },
      { name: 'Leadership', slug: 'leadership', description: 'Developing leadership presence, team motivation, delegation, and decision-making in managerial roles.', meta_description: 'Develop leadership skills. Learn to motivate teams, make decisions, and lead effectively in managerial and executive roles.', sort_order: 2 },
      { name: 'Strategic Planning', slug: 'strategic-planning', description: 'Frameworks for developing, communicating, and executing organizational strategy aligned with business goals.', meta_description: 'Learn strategic planning. Master business strategy frameworks for setting direction and executing organizational goals.', sort_order: 3 },
      { name: 'Business Analysis', slug: 'business-analysis', description: 'Requirements gathering, process mapping, stakeholder communication, and translating business needs into solutions.', meta_description: 'Learn business analysis. Cover requirements gathering, process mapping, and bridging business and technical teams.', sort_order: 4 },
      { name: 'Change Management', slug: 'change-management', description: 'Planning and managing organizational transitions — stakeholder engagement, resistance handling, and change adoption.', meta_description: 'Learn change management. Lead organizational transitions, manage resistance, and drive successful change adoption.', sort_order: 5 },
      { name: 'Entrepreneurship', slug: 'entrepreneurship', description: 'Startup fundamentals — ideation, validation, fundraising, growth strategies, and building products from zero.', meta_description: 'Learn entrepreneurship and startup skills. Cover ideation, validation, fundraising, and building products from scratch.', sort_order: 6 },
      { name: 'Stakeholder Management', slug: 'stakeholder-management', description: 'Identifying, prioritizing, and communicating with stakeholders to align interests and maintain project support.', meta_description: 'Learn stakeholder management. Build skills to identify, engage, and align stakeholders across complex projects.', sort_order: 7 },
    ],
  },
  {
    name: 'Marketing & Growth',
    slug: 'marketing-growth',
    description: 'Digital marketing skills for reaching and growing an audience online — from SEO and paid ads to content strategy, email, and e-commerce.',
    meta_description: 'Browse marketing and growth courses. Learn digital marketing, SEO, social media, email marketing, and e-commerce.',
    sort_order: 12,
    subtopics: [
      { name: 'Digital Marketing', slug: 'digital-marketing', description: 'Strategy, channels, and measurement for marketing products and services across digital platforms.', meta_description: 'Learn digital marketing strategy. Cover paid ads, social, email, and analytics for marketing in the digital landscape.', sort_order: 1 },
      { name: 'SEO', slug: 'seo', description: 'On-page, off-page, and technical SEO — keyword research, link building, and ranking in organic search.', meta_description: 'Learn SEO and search engine optimization. Master keyword research, on-page SEO, link building, and technical SEO.', sort_order: 2 },
      { name: 'Social Media Marketing', slug: 'social-media-marketing', description: 'Building brand presence, running paid campaigns, and growing engagement across social platforms.', meta_description: 'Learn social media marketing. Grow brand presence, run paid campaigns, and drive engagement across social platforms.', sort_order: 3 },
      { name: 'Email Marketing', slug: 'email-marketing', description: 'List building, segmentation, automation, copywriting, and deliverability for effective email campaigns.', meta_description: 'Learn email marketing. Build lists, automate campaigns, and write copy that drives opens, clicks, and conversions.', sort_order: 4 },
      { name: 'Content Creation', slug: 'content-creation', description: 'Writing, video, and multimedia content strategy for attracting and retaining audiences across platforms.', meta_description: 'Learn content creation and strategy. Produce written, video, and multimedia content that attracts and retains audiences.', sort_order: 5 },
      { name: 'Branding', slug: 'branding', description: 'Brand identity, positioning, visual systems, and storytelling that build recognition and customer loyalty.', meta_description: 'Learn branding and brand strategy. Develop brand identities, positioning, and storytelling for lasting customer loyalty.', sort_order: 6 },
      { name: 'E-commerce', slug: 'ecommerce', description: 'Building and growing online stores — Shopify, WooCommerce, product listings, conversion optimization, and logistics.', meta_description: 'Learn e-commerce and online retail. Build and grow online stores with Shopify, WooCommerce, and conversion strategies.', sort_order: 7 },
      { name: 'Marketing Analytics', slug: 'marketing-analytics', description: 'Measuring campaign performance, attribution modelling, and using data to optimize marketing ROI.', meta_description: 'Learn marketing analytics. Measure campaign performance, attribution, and use data to optimize marketing spend.', sort_order: 8 },
    ],
  },
  {
    name: 'Finance & Accounting',
    slug: 'finance-accounting',
    description: 'Financial analysis, accounting principles, and risk frameworks used across corporate finance, investment, and business operations.',
    meta_description: 'Find top finance and accounting courses. Learn financial analysis, accounting, risk management, and financial modeling.',
    sort_order: 13,
    subtopics: [
      { name: 'Financial Analysis', slug: 'financial-analysis', description: 'Reading financial statements, ratio analysis, valuation methods, and evaluating business and investment performance.', meta_description: 'Learn financial analysis. Master financial statements, ratio analysis, and valuation techniques for business and investing.', sort_order: 1 },
      { name: 'Accounting', slug: 'accounting', description: 'Bookkeeping, debits and credits, financial reporting, and accounting standards (GAAP/IFRS).', meta_description: 'Learn accounting fundamentals. Cover bookkeeping, financial reporting, and accounting standards (GAAP/IFRS).', sort_order: 2 },
      { name: 'Risk Management', slug: 'risk-management', description: 'Identifying, measuring, and mitigating financial and operational risks in business and investment contexts.', meta_description: 'Learn risk management. Identify, assess, and mitigate financial and operational risks across business contexts.', sort_order: 3 },
      { name: 'Economics', slug: 'economics', description: 'Microeconomics, macroeconomics, market dynamics, and applying economic principles to business decisions.', meta_description: 'Learn economics for business. Cover microeconomics, macroeconomics, and applying economic thinking to decisions.', sort_order: 4 },
      { name: 'Forecasting', slug: 'forecasting', description: 'Financial forecasting, budgeting, scenario analysis, and building models to project business performance.', meta_description: 'Learn financial forecasting and budgeting. Build forecast models and scenario analyses to project business performance.', sort_order: 5 },
      { name: 'Financial Modeling', slug: 'financial-modeling', description: 'Building DCF, LBO, and three-statement models in Excel for investment banking, corporate finance, and FP&A.', meta_description: 'Learn financial modeling. Build DCF, LBO, and three-statement models for investment banking and corporate finance.', sort_order: 6 },
      { name: 'Investment', slug: 'investment', description: 'Investment principles, portfolio theory, equities, bonds, and personal finance for wealth building.', meta_description: 'Learn investment and portfolio management. Cover equities, bonds, portfolio theory, and personal finance strategies.', sort_order: 7 },
    ],
  },
  {
    name: 'Personal Development',
    slug: 'personal-development',
    description: 'Soft skills and mindset skills that improve effectiveness across every role — communication, critical thinking, emotional intelligence, and time management.',
    meta_description: 'Explore personal development courses. Build communication, critical thinking, emotional intelligence, and productivity skills.',
    sort_order: 14,
    subtopics: [
      { name: 'Communication', slug: 'communication', description: 'Written and verbal communication, active listening, presentation skills, and communicating with clarity and impact.', meta_description: 'Improve your communication skills. Learn to write clearly, speak confidently, and communicate with impact professionally.', sort_order: 1 },
      { name: 'Critical Thinking', slug: 'critical-thinking', description: 'Evaluating arguments, identifying logical fallacies, and applying structured frameworks to complex problems.', meta_description: 'Develop critical thinking skills. Learn structured problem-solving, argument analysis, and sound reasoning frameworks.', sort_order: 2 },
      { name: 'Emotional Intelligence', slug: 'emotional-intelligence', description: 'Self-awareness, empathy, social skills, and managing emotions effectively in professional environments.', meta_description: 'Build emotional intelligence skills. Develop self-awareness, empathy, and interpersonal skills for career and leadership success.', sort_order: 3 },
      { name: 'Time Management', slug: 'time-management', description: 'Prioritization frameworks, focus techniques, and building habits and systems to manage work and energy.', meta_description: 'Learn time management and productivity. Master prioritization, focus, and building systems to get more done.', sort_order: 4 },
      { name: 'Creativity', slug: 'creativity', description: 'Techniques for generating ideas, overcoming creative blocks, design thinking, and fostering innovation.', meta_description: 'Develop creativity and innovation skills. Learn ideation techniques, design thinking, and strategies to foster creativity.', sort_order: 5 },
      { name: 'Negotiation', slug: 'negotiation', description: 'Principled negotiation tactics, preparation frameworks, and influence techniques for professional and personal settings.', meta_description: 'Learn negotiation skills. Master negotiation tactics, preparation, and influence strategies for professional success.', sort_order: 6 },
      { name: 'Problem Solving', slug: 'problem-solving', description: 'Structured methodologies for diagnosing, framing, and resolving complex problems in work and business.', meta_description: 'Improve your problem-solving skills. Learn structured frameworks for diagnosing and resolving complex challenges.', sort_order: 7 },
    ],
  },
  {
    name: 'IT & Networking',
    slug: 'it-networking',
    description: 'Infrastructure, networking, and systems administration fundamentals for IT professionals and those preparing for CompTIA, Cisco, or similar certifications.',
    meta_description: 'Browse IT and networking courses. Learn networking fundamentals, system administration, virtualization, and IT support.',
    sort_order: 15,
    subtopics: [
      { name: 'Networking Fundamentals', slug: 'networking-fundamentals', description: 'TCP/IP, OSI model, routing, switching, and the protocols that underpin modern computer networks.', meta_description: 'Learn networking fundamentals. Master TCP/IP, OSI model, routing, and switching for CompTIA Network+ and beyond.', sort_order: 1 },
      { name: 'System Administration', slug: 'system-administration', description: 'Managing servers, user accounts, file systems, and services across Windows Server and Linux environments.', meta_description: 'Learn system administration. Manage Windows Server and Linux systems, users, storage, and services at scale.', sort_order: 2 },
      { name: 'Virtualization', slug: 'virtualization', description: 'Hypervisors, virtual machines, and VMware/Hyper-V for server consolidation and lab environments.', meta_description: 'Learn virtualization. Set up and manage VMs with VMware, Hyper-V, and virtualization for server consolidation.', sort_order: 3 },
      { name: 'Linux Administration', slug: 'linux-administration', description: 'Advanced Linux system management — package management, services, logging, cron, and performance tuning.', meta_description: 'Learn Linux system administration. Manage Linux servers, services, and performance tuning for production environments.', sort_order: 4 },
      { name: 'Help Desk & IT Support', slug: 'help-desk-it-support', description: 'Troubleshooting methodology, ticketing systems, hardware support, and CompTIA A+ certification preparation.', meta_description: 'Learn IT support and help desk skills. Prepare for CompTIA A+ and build troubleshooting skills for IT careers.', sort_order: 5 },
      { name: 'Configuration Management', slug: 'configuration-management', description: 'Managing system state at scale using Ansible, Puppet, and Chef — idempotent configuration and compliance drift detection.', meta_description: 'Learn configuration management. Automate system state with Ansible, Puppet, and Chef across large infrastructure.', sort_order: 6 },
    ],
  },
  {
    name: 'Office & Productivity',
    slug: 'office-productivity',
    description: 'Essential workplace tools for business professionals — spreadsheets, word processing, presentations, and productivity software used in every industry.',
    meta_description: 'Browse office and productivity courses. Learn Microsoft Excel, Microsoft 365, Google Workspace, and business software.',
    sort_order: 16,
    subtopics: [
      { name: 'Microsoft Excel', slug: 'microsoft-excel', description: 'Spreadsheet fundamentals to advanced Excel — formulas, PivotTables, Power Query, macros, and data analysis.', meta_description: 'Learn Microsoft Excel. Master formulas, PivotTables, Power Query, and Excel for business analysis and reporting.', sort_order: 1 },
      { name: 'Microsoft 365', slug: 'microsoft-365', description: 'The full Microsoft 365 suite — Word, PowerPoint, Teams, SharePoint, and OneDrive for workplace collaboration.', meta_description: 'Learn Microsoft 365. Master Word, PowerPoint, Teams, SharePoint, and OneDrive for professional collaboration.', sort_order: 2 },
      { name: 'Google Workspace', slug: 'google-workspace', description: 'Google Docs, Sheets, Slides, Drive, and Meet for teams that collaborate in Google\'s productivity ecosystem.', meta_description: 'Learn Google Workspace. Master Google Docs, Sheets, Slides, and Drive for cloud-based team collaboration.', sort_order: 3 },
      { name: 'Presentations', slug: 'presentations', description: 'Structuring, designing, and delivering effective presentations — slide design, storytelling, and public speaking.', meta_description: 'Learn to create and deliver effective presentations. Cover slide design, storytelling, and confident public speaking skills.', sort_order: 4 },
      { name: 'Workflow Management', slug: 'workflow-management', description: 'Tools and systems for managing tasks, projects, and team workflows — Notion, Asana, Monday.com, and Jira.', meta_description: 'Learn workflow management tools. Organize tasks and projects with Notion, Asana, Monday.com, and Jira.', sort_order: 5 },
    ],
  },
  {
    name: 'Math & Science',
    slug: 'math-science',
    description: 'Mathematical foundations and scientific methods that underpin data science, engineering, and analytical thinking across technical disciplines.',
    meta_description: 'Explore math and science courses. Learn statistics, algebra, calculus, and research methods for data science and engineering.',
    sort_order: 17,
    subtopics: [
      { name: 'Statistics', slug: 'statistics', description: 'Descriptive and inferential statistics, probability distributions, and statistical thinking for data science and research.', meta_description: 'Learn statistics for data science. Cover descriptive stats, probability, distributions, and statistical inference.', sort_order: 1 },
      { name: 'Algebra', slug: 'algebra', description: 'Linear algebra, matrix operations, and algebraic structures that underpin machine learning and computer graphics.', meta_description: 'Learn algebra and linear algebra. Master matrix operations and algebraic concepts essential for machine learning.', sort_order: 2 },
      { name: 'Calculus', slug: 'calculus', description: 'Differential and integral calculus, limits, and optimization — foundational for machine learning and physics.', meta_description: 'Learn calculus for data science and engineering. Cover derivatives, integrals, and optimization fundamentals.', sort_order: 3 },
      { name: 'Data Science Foundations', slug: 'data-science-foundations', description: 'Core mathematical and statistical concepts — probability, linear algebra, and calculus — that underpin data science.', meta_description: 'Build your data science foundations. Cover probability, linear algebra, and calculus to prepare for advanced ML courses.', sort_order: 4 },
      { name: 'Research Methods', slug: 'research-methods', description: 'Experimental design, hypothesis formulation, data collection, and academic and applied research methodology.', meta_description: 'Learn research methods and experimental design. Cover hypothesis testing, data collection, and research methodology.', sort_order: 5 },
    ],
  },
]

async function seedTopics(): Promise<void> {
  console.log('Seeding topics...')

  // ── Step 1: Upsert all domain (parent) topics ─────────────────────────────
  console.log(`Upserting ${DOMAINS.length} domains...`)
  for (const domain of DOMAINS) {
    await db
      .insert(topics)
      .values({
        name: domain.name,
        slug: domain.slug,
        description: domain.description,
        meta_description: domain.meta_description,
        sort_order: domain.sort_order,
        parent_id: null,
      })
      .onConflictDoUpdate({
        target: topics.slug,
        set: {
          name: domain.name,
          description: domain.description,
          meta_description: domain.meta_description,
          sort_order: domain.sort_order,
          updated_at: new Date(),
        },
      })
  }

  // ── Step 2: Load domain IDs for parent_id lookup ──────────────────────────
  const domainRows = await db
    .select({ id: topics.id, slug: topics.slug })
    .from(topics)
    .where(isNull(topics.parent_id))

  const slugToId = new Map(domainRows.map(r => [r.slug, r.id]))

  // ── Step 3: Upsert all subtopics with parent_id ───────────────────────────
  const subtopicCount = DOMAINS.reduce((n, d) => n + d.subtopics.length, 0)
  console.log(`Upserting ${subtopicCount} subtopics...`)

  for (const domain of DOMAINS) {
    const parentId = slugToId.get(domain.slug)
    if (!parentId) {
      console.error(`ERROR: no ID found for domain slug "${domain.slug}" — skipping its subtopics`)
      continue
    }
    for (const sub of domain.subtopics) {
      await db
        .insert(topics)
        .values({
          name: sub.name,
          slug: sub.slug,
          description: sub.description,
          meta_description: sub.meta_description,
          sort_order: sub.sort_order,
          parent_id: parentId,
        })
        .onConflictDoUpdate({
          target: topics.slug,
          set: {
            name: sub.name,
            description: sub.description,
            meta_description: sub.meta_description,
            sort_order: sub.sort_order,
            parent_id: parentId,
            updated_at: new Date(),
          },
        })
    }
  }

  const total = DOMAINS.length + subtopicCount
  console.log(`Done. ${total} topics upserted (${DOMAINS.length} domains, ${subtopicCount} subtopics).`)
}

seedTopics()
  .catch(err => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(() => closeDb())
