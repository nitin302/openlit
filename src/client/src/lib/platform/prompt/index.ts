import { PromptInput, SpecificPromptInput } from "@/constants/prompts";
import { dataCollector } from "../common";
import {
	OPENLIT_PROMPTS_TABLE_NAME,
	OPENLIT_PROMPT_VERSIONS_TABLE_NAME,
	OPENLIT_PROMPT_VERSION_DOWNLOADS_TABLE_NAME,
} from "./table-details";
import { verifyPromptInput } from "@/helpers/prompt";
import { getCurrentUser } from "@/lib/session";
import { jsonStringify } from "@/utils/json";

export async function getPromptByName({ name }: { name: string }) {
	const query = `
		SELECT * FROM ${OPENLIT_PROMPTS_TABLE_NAME} WHERE name='${name}';
  `;

	const { data }: { data?: any } = await dataCollector({ query });
	return data?.[0];
}

export async function checkNameValidity({ name }: { name: string }) {
	const data = await getPromptByName({ name });
	return { isValid: !data?.id };
}

export async function createPrompt(promptInput: PromptInput) {
	const user = await getCurrentUser();

	if (!user) throw new Error("Unauthorized user!");

	const verifiedPrompt = verifyPromptInput(promptInput);
	if (!verifiedPrompt.success) throw new Error(verifiedPrompt.err);

	const { isValid } = await checkNameValidity({ name: promptInput.name });
	if (!isValid) {
		throw new Error("Prompt name is already taken!");
	}

	const { err } = await dataCollector(
		{
			table: OPENLIT_PROMPTS_TABLE_NAME,
			values: [{ name: promptInput.name, created_by: user.email }],
		},
		"insert"
	);

	if (err) throw new Error(err.toString());

	const promptData = await getPromptByName({
		name: promptInput.name,
	});
	if (!promptData?.id) {
		throw new Error("Prompt cannot be created!");
	}

	const { err: versionErr, data: versionData } = await dataCollector(
		{
			table: OPENLIT_PROMPT_VERSIONS_TABLE_NAME,
			values: [
				{
					prompt_id: promptData.id,
					updated_by: user.email,
					version: promptInput.version,
					status: promptInput.status,
					prompt: promptInput.prompt,
					tags: promptInput.tags,
					meta_properties: promptInput.metaProperties,
				},
			],
		},
		"insert"
	);

	if (versionErr || !(versionData as { query_id: unknown })?.query_id)
		throw new Error(
			(versionErr as any).toString() || "Version cannot be saved"
		);

	return {
		data: { promptId: promptData.id },
		message: "Prompt saved successfully!",
	};
}

export async function getPrompts() {
	const user = await getCurrentUser();

	if (!user) throw new Error("Unauthorized user!");

	const query = `SELECT
			p.id AS promptId,
			p.name AS name,
			p.created_by AS createdBy,
			COUNT(DISTINCT v.version) AS totalVersions,         -- Total number of versions for each prompt
			MAX(v.version) AS latestVersion,           -- Latest version by version number
			any(v.updated_at) AS latestVersionDate,   -- The date when the latest version was updated
			any(v.status) AS latestVersionStatus,      -- Status of the latest version in PUBLISHED state
			countIf(d.download_id != '00000000-0000-0000-0000-000000000000') AS totalDownloads                   -- Total downloads for the prompt
		FROM
				${OPENLIT_PROMPTS_TABLE_NAME} p
		LEFT JOIN
				${OPENLIT_PROMPT_VERSIONS_TABLE_NAME} v ON p.id = v.prompt_id
				AND v.status != 'DRAFT'
		LEFT JOIN
				${OPENLIT_PROMPT_VERSION_DOWNLOADS_TABLE_NAME} d ON p.id = d.prompt_id  -- Join with downloads table
		GROUP BY
				p.id, p.name, p.created_by, p.created_at
		ORDER BY
				p.created_at DESC;
	`;

	return await dataCollector({ query });
}

export async function getSpecificPrompt(
	promptInput: Partial<SpecificPromptInput>,
	dbConfigId?: string
) {
	const conditionClauses = [];
	if (promptInput.id) {
		conditionClauses.push(`p.id = '${promptInput.id}'`);
	}

	if (promptInput.name) {
		conditionClauses.push(`p.name = '${promptInput.name}'`);
	}

	if (promptInput.version) {
		conditionClauses.push(`v.version = '${promptInput.version}'`);
	}

	const query = `
    SELECT
      p.id AS promptId,
      v.version_id AS versionId,
      p.name AS name,
      v.version AS version,
      v.tags AS tags,
      v.meta_properties AS metaProperties,
      v.prompt AS prompt
    FROM
      ${OPENLIT_PROMPTS_TABLE_NAME} p
    LEFT JOIN
      ${OPENLIT_PROMPT_VERSIONS_TABLE_NAME} v ON p.id = v.prompt_id
      AND v.status != 'DRAFT'
    WHERE ${conditionClauses.join(" AND ")}
    ORDER BY
      v.version DESC
    `;

	return dataCollector({ query }, "query", dbConfigId);
}

export async function getPromptDetails(
	promptId: string,
	params?: { version?: string }
) {
	const user = await getCurrentUser();

	if (!user) throw new Error("Unauthorized user!");

	const promptVersionQuery = `
    SELECT
    p.id AS promptId,
    p.name AS name,
    p.created_by AS createdBy,
    p.created_at AS createdAt,
		v.version_id AS versionId,
    v.prompt AS prompt,                                         -- Selected prompt content
    toString(v.status) AS status,                               -- Version status (e.g., DRAFT, PUBLISHED)
    v.updated_at AS updatedAt,                                  -- When the version was last updated
    v.version AS version,                                       -- Version number (e.g., 1.0.0)
    v.meta_properties AS metaProperties,                        -- Meta properties for the version
    v.tags AS tags                                              -- Tags for the version
FROM
    ${OPENLIT_PROMPTS_TABLE_NAME} p
LEFT JOIN
    (
        SELECT
            version_id, prompt_id, prompt, version, status, meta_properties, tags, updated_by, updated_at
        FROM
            ${OPENLIT_PROMPT_VERSIONS_TABLE_NAME}
        WHERE
            prompt_id = '${promptId}'
						${
							params?.version
								? `AND version='${params.version}' AND status != 'DRAFT'`
								: ""
						}
        ORDER BY
            status DESC,         -- Prioritize draft versions (DRAFT first)
            version DESC                   -- Then order by version number (latest first)
        LIMIT 1                            -- Fetch the highest priority version (either DRAFT or latest PUBLISHED)
    ) v
ON p.id = v.prompt_id
WHERE
    p.id = '${promptId}'                   -- Filter by specific prompt ID
ORDER BY
    p.created_at DESC;

    `;

	const promptVersionsListQuery = `SELECT
    v.version_id AS versionId,
    v.prompt_id AS promptId,
    v.prompt AS prompt,
    v.version AS version,                       -- Version number (e.g., 1.0.0)
    v.status AS status,                         -- Status of the version (e.g., DRAFT or PUBLISHED)
    v.meta_properties AS metaProperties,        -- Meta properties for the version
    v.tags AS tags,                             -- Tags for the version
    v.updated_by AS updatedBy,                  -- Who updated the version
    v.updated_at AS updatedAt                   -- When the version was last updated
FROM
    ${OPENLIT_PROMPT_VERSIONS_TABLE_NAME} v
WHERE
    v.prompt_id = '${promptId}'                 -- Filter by specific prompt ID
ORDER BY
    v.status = 'DRAFT' DESC,                  -- Prioritize DRAFT versions
    v.version DESC;                            
`;

	return Promise.all([
		await dataCollector({ query: promptVersionQuery }, "query"),
		await dataCollector({ query: promptVersionsListQuery }, "query"),
	]).then(([versionData, versionsList]) => {
		let combinedData: any | null = null;
		if ((versionData.data as any[])?.[0]) {
			combinedData = (versionData.data as any[])[0];
			combinedData.versions = versionsList.data || [];
		}

		return {
			err: versionData.err || versionsList.err,
			data: [combinedData],
		};
	});
}
