import fs from "fs/promises";

// ---------------- Configuration ---------------- //
const BASE_URL = "https://maharatech.gov.eg";
const DATA_FILE = "./maharatech_courses.json";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 12000;
const MAX_BYTES = 512 * 1024;
const MAX_RETRIES = 2;
const CONCURRENT_WORKERS = 25;

// Ignored page titles (login walls, error pages, placeholders)
const IGNORED_TITLES = new Set([
  "notice",
  "تنبيه",
  "error",
  "خطأ",
  "log in to the site",
  "تسجيل الدخول إلى الموقع",
  "maharatech",
  "mahara-tech",
  "title not found",
]);

// ---------------- Helper Functions ---------------- //

/**
 * Clean course title by stripping prefixes and portal suffixes
 */
const cleanCourseTitle = (rawTitle) => {
  if (!rawTitle) return null;
  const cleaned = rawTitle
    .replace(/<[^>]*>/g, "")
    .replace(/^Course:\s*/i, "")
    .replace(/^المقرر:\s*/i, "")
    .replace(/\s*\|\s*Mahara-?Tech.*$/i, "")
    .replace(/\s*\|\s*مهارة\s*تك.*$/i, "")
    .trim();

  if (!cleaned || IGNORED_TITLES.has(cleaned.toLowerCase())) {
    return null;
  }
  return cleaned;
};

/**
 * Extract course cover image URL from page HTML buffer
 */
const extractCoverUrl = (htmlBuffer) => {
  // Strategy 1: Specific track / banner images
  const bannerMatch = htmlBuffer.match(
    /<img[^>]+src=["']([^"']*(?:newBanners\/tracks\/|-course-banner|banner|Brain)[^"']*)["']/i,
  );
  if (bannerMatch) return resolveUrl(bannerMatch[1]);

  // Strategy 2: Cocoon custom block content images
  const cocoonMatch = htmlBuffer.match(
    /block_cocoon_custom_html[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i,
  );
  if (cocoonMatch) {
    const imgMatches = [
      ...cocoonMatch[0].matchAll(/<img[^>]+src=["']([^"']+)["']/gi),
    ];
    for (const match of imgMatches) {
      const src = match[1];
      if (!isAvatarOrIcon(src)) {
        return resolveUrl(src);
      }
    }
  }

  // Strategy 3: Generic course image / track paths
  const genericMatch = htmlBuffer.match(
    /<img[^>]+src=["']([^"']*(?:pix\/newBanners|\/course\/|CoursesImgs|cs_academy|pix\/courses)[^"']+)["']/i,
  );
  if (genericMatch && !isAvatarOrIcon(genericMatch[1])) {
    return resolveUrl(genericMatch[1]);
  }

  return null;
};

const isAvatarOrIcon = (src) =>
  src.includes("user") ||
  src.includes("avatar") ||
  src.includes("pix/u/") ||
  src.includes("icon") ||
  src.includes("overviewfiles");

const resolveUrl = (url) => {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
};

// ---------------- Network Fetcher ---------------- //

/**
 * Fetch course details (Title & Cover) by course ID with streaming & retry
 */
const fetchCourseById = async (id, attempt = 1) => {
  const url = `${BASE_URL}/course/view.php?id=${id}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("timeout")),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt <= MAX_RETRIES
      ) {
        await response.body?.cancel();
        clearTimeout(timeout);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        return fetchCourseById(id, attempt + 1);
      }
      await response.body?.cancel();
      return null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytesRead = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.length;
      buffer += decoder.decode(value, { stream: true });

      // Early break if we have read past the main course header blocks
      if (
        buffer.includes("block_cocoon_custom_html") &&
        buffer.includes("</div>") &&
        buffer.includes("</h2>") &&
        buffer.length > 50000
      ) {
        await reader.cancel();
        break;
      }

      if (bytesRead >= MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }

    // Extract Title
    let titleMatch = buffer.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (!titleMatch) {
      titleMatch = buffer.match(
        /<(?:h1|span)[^>]*class="[^"]*(?:coursename|page-header-headings)[^"]*"[^>]*>([\s\S]*?)<\/(?:h1|span)>/i,
      );
    }
    if (!titleMatch) return null;

    const courseName = cleanCourseTitle(titleMatch[1]);
    if (!courseName) return null;

    const cover = extractCoverUrl(buffer);

    return {
      ID: id,
      course_name: courseName,
      main_category: "General & Core Topics",
      cover,
    };
  } catch {
    if (attempt <= MAX_RETRIES) {
      clearTimeout(timeout);
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return fetchCourseById(id, attempt + 1);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

// ---------------- Database & Storage ---------------- //

const loadCourses = async () => {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : data.courses || [];
  } catch {
    return [];
  }
};

const saveCourses = async (courses) => {
  courses.sort((a, b) => (a.ID ?? a.id) - (b.ID ?? b.id));
  await fs.writeFile(DATA_FILE, JSON.stringify(courses, null, 4), "utf-8");
};

// ---------------- Scraping Tasks ---------------- //

/**
 * Scan a range of IDs and incrementally add new courses to maharatech_courses.json
 */
const scrapeRange = async (
  startId,
  endId,
  concurrency = CONCURRENT_WORKERS,
) => {
  const coursesList = await loadCourses();
  const existingMap = new Map();
  for (const c of coursesList) {
    const id = c.ID ?? c.id;
    if (id !== undefined) existingMap.set(id, c);
  }

  const pendingIds = [];
  for (let id = startId; id <= endId; id++) {
    if (!existingMap.has(id)) {
      pendingIds.push(id);
    }
  }

  const total = pendingIds.length;
  console.log(
    `Loaded ${coursesList.length} existing courses from ${DATA_FILE}.`,
  );
  console.log(
    `Scanning ${total} new IDs in range [${startId}-${endId}] with ${concurrency} workers...\n`,
  );

  if (total === 0) {
    console.log("All requested IDs are already indexed. No new IDs to scan.");
    return coursesList;
  }

  let index = 0;
  let completed = 0;
  let newValid = 0;

  const worker = async () => {
    while (index < pendingIds.length) {
      const id = pendingIds[index++];
      const course = await fetchCourseById(id);

      if (course) {
        existingMap.set(id, course);
        newValid++;
      }

      completed++;
      if (completed % 10 === 0 || completed === total) {
        process.stdout.write(
          `\rProgress: ${completed}/${total} (${Math.round((completed / total) * 100)}%) | New Courses Found: ${newValid}`,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const updatedCourses = Array.from(existingMap.values());
  console.log(`\n\nSaving ${updatedCourses.length} courses to ${DATA_FILE}...`);
  await saveCourses(updatedCourses);
  console.log(`Successfully updated ${DATA_FILE}!`);

  return updatedCourses;
};

// ---------------- Execution ---------------- //
const START_ID = 1;
const END_ID = 2500;

await scrapeRange(START_ID, END_ID, CONCURRENT_WORKERS);
