import { MobileShell } from "@/components/MobileShell";
import { Pagination } from "@/components/Widgets";
import { buildCatalogModel } from "@/lib/server/selectors/catalog";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { mobilePageSize, MobileCatalogList, MobileSection, scalar } from "../mobile-ui";

export default async function MobileCatalogPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const model = buildCatalogModel(filters);
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const totalPages = Math.max(1, Math.ceil(model.catalog.length / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const offset = (effectivePage - 1) * pageSize;
  const rows = model.catalog.slice(offset, offset + pageSize);
  return (
    <MobileShell active="/m/catalog" model={model} filters={filters} desktopPath="/catalog">
      <MobileSection title="Catalog" detail={`${model.catalog.length} rows`}>
        <MobileCatalogList rows={rows} />
        <Pagination basePath="/m/catalog" page={effectivePage} pageSize={pageSize} total={model.catalog.length} totalPages={totalPages} />
      </MobileSection>
    </MobileShell>
  );
}
