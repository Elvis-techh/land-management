const PUBLISHED = { owner: "lindero123", staff: "asociado123" };
const MINIMUM_LENGTH = 12;
function fromEnvironment(name, environment) {
    const password = environment[name] ?? "";
    if (password === "") {
        throw new Error(`${name} must be set in the test site's .env`);
    }
    if (password.length < MINIMUM_LENGTH) {
        throw new Error(`${name} must be at least ${MINIMUM_LENGTH} characters`);
    }
    if (password === PUBLISHED.owner || password === PUBLISHED.staff) {
        throw new Error(`${name} is one of the demo passwords published in this repository`);
    }
    return password;
}
/**
 * The passwords the demo accounts get.
 *
 * On a laptop, the ones written in this repository. That is exactly why the test
 * site cannot use them: it is on the internet and this repository is public, so
 * anyone could log in, and every reset would put them back. It takes its own
 * from its `.env` on the droplet, and refuses to seed without them.
 */
export function demoPasswords(config, environment = process.env) {
    if (config.site !== "test") {
        return PUBLISHED;
    }
    return {
        owner: fromEnvironment("TEST_SITE_SUPERVISOR_PASSWORD", environment),
        staff: fromEnvironment("TEST_SITE_ASSOCIATE_PASSWORD", environment),
    };
}
//# sourceMappingURL=demoLogins.js.map