import { McpError, ErrorCode, AxiosResponse } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl } from '../lib/utils';
import convert from 'xml-js';
import { maybeBackground } from '../lib/background';
import { cacheKey, getCachedList, setCachedList } from '../lib/queryCache';

interface PackageObj {
    OBJECT_TYPE: string;
    OBJECT_NAME: string;
    OBJECT_DESCRIPTION?: string;
    OBJECT_URI: string;
}

export async function handleGetPackage(args: any) {
    const name = args?.package_name ? String(args.package_name).toUpperCase() : 'package';
    const slug = `package-${name}`;
    return maybeBackground(args, `Package listing for ${name}`, slug, () => getPackageCore(args));
}

async function getPackageCore(args: any) {
    try {
        if (!args?.package_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Package name is required');
        }
        const packageName = String(args.package_name).toUpperCase();

        // The full, unsorted object list — cached so a follow-up call with a different
        // offset/max_results pages without re-fetching from SAP.
        const key = cacheKey('GetPackage', { package_name: packageName });
        let extractedData = getCachedList<PackageObj>(key);
        const fromCache = !!extractedData;

        if (!extractedData) {
            const nodeContentsUrl = `${await getBaseUrl()}/sap/bc/adt/repository/nodestructure`;
            const encodedPackageName = encodeURIComponent(packageName);
            const nodeContentsParams = {
                parent_type: "DEVC/K",
                parent_name: encodedPackageName,
                withShortDescriptions: true
            };

            const package_structure_response = await makeAdtRequest(nodeContentsUrl, 'POST', 30000, undefined, nodeContentsParams);
            const result = convert.xml2js(package_structure_response.data, {compact: true});

            const nodes = result["asx:abap"]?.["asx:values"]?.DATA?.TREE_CONTENT?.SEU_ADT_REPOSITORY_OBJ_NODE || [];
            extractedData = (Array.isArray(nodes) ? nodes : [nodes]).filter((node: any) =>
                node.OBJECT_NAME?._text && node.OBJECT_URI?._text
            ).map((node: any): PackageObj => ({
                OBJECT_TYPE: node.OBJECT_TYPE._text,
                OBJECT_NAME: node.OBJECT_NAME._text,
                OBJECT_DESCRIPTION: node.DESCRIPTION?._text,
                OBJECT_URI: node.OBJECT_URI._text
            }));

            setCachedList(key, extractedData);
        }

        if (extractedData.length === 0) {
            return { isError: false, content: [{ type: 'text', text: `Package '${packageName}' is empty or not found.` }] };
        }

        const maxResults = Math.max(1, Number(args?.max_results) || 200);
        const offset = Math.max(0, Number(args?.offset) || 0);
        const total = extractedData.length;

        // Group by object type (alphabetical), then flatten to the exact order rendered —
        // this is the order offset/max_results windows over.
        const grouped: Record<string, PackageObj[]> = {};
        for (const obj of extractedData) {
            const t = obj.OBJECT_TYPE || 'UNKNOWN';
            if (!grouped[t]) grouped[t] = [];
            grouped[t].push(obj);
        }
        const ordered: { type: string; item: PackageObj }[] = [];
        for (const [type, items] of Object.entries(grouped).sort()) {
            for (const item of items) ordered.push({ type, item });
        }
        const windowed = ordered.slice(offset, offset + maxResults);
        const windowEnd = offset + windowed.length;

        const header = total > windowEnd || offset > 0
            ? `Total Objects: ${total} (showing ${windowed.length === 0 ? 0 : offset + 1}-${windowEnd}${total > windowEnd ? ' — raise max_results or offset to see more' : ''})`
            : `Total Objects: ${total}`;
        const lines: string[] = [`Package: ${packageName}${fromCache ? ' [cached]' : ''}`, header, ''];

        // Regroup the windowed slice for display, preserving order.
        const displayGroups: Record<string, PackageObj[]> = {};
        for (const { type, item } of windowed) {
            if (!displayGroups[type]) displayGroups[type] = [];
            displayGroups[type].push(item);
        }
        for (const [type, items] of Object.entries(displayGroups)) {
            const totalInGroup = grouped[type].length;
            const suffix = items.length < totalInGroup ? `, showing ${items.length}` : '';
            lines.push(`── ${type} (${totalInGroup}${suffix})`);
            for (const item of items) {
                const desc = item.OBJECT_DESCRIPTION ? `  ${item.OBJECT_DESCRIPTION}` : '';
                lines.push(`   ${item.OBJECT_NAME.padEnd(40)}${desc}`);
            }
            lines.push('');
        }

        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };

    } catch (error) {
        return return_error(error);
    }
}
