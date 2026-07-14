// Scratch: boot the web stack, drive the admin login in Playwright, dump state.
import { bootWebAppStack, OPERATOR, CUSTOMER } from "../src/webapps.mjs";
import { launchPlaywright } from "../src/browser.mjs";

const stack = await bootWebAppStack();
const pw = await launchPlaywright();
try {
  const nav = await pw.page.goto(stack.admin.url, { waitUntil: "domcontentloaded" });
  console.log("landing:", nav.status(), pw.page.url());

  await pw.page.fill('input[name="email"]', OPERATOR.email);
  await pw.page.fill('input[name="password"]', OPERATOR.password);
  const [response] = await Promise.all([
    pw.page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch((e) => e.message),
    pw.page.click('form[action="/login"] button'),
  ]);
  console.log("after submit:", typeof response === "string" ? response : response?.status(), pw.page.url());
  const body = await pw.page.evaluate(() => document.body?.innerText?.slice(0, 500));
  console.log("body text:", JSON.stringify(body));
  const cookies = await pw.context.cookies(stack.admin.url);
  console.log("cookies:", cookies.map((c) => `${c.name} httpOnly=${c.httpOnly} sameSite=${c.sameSite}`));
} finally {
  await pw.close();
  await stack.stop();
}
