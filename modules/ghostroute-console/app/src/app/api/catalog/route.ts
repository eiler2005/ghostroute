import { NextResponse } from "next/server";
import { buildCatalogModel } from "@/lib/server/selectors/catalog";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET() {
  const model = buildCatalogModel();
  const catalog = model.catalog;
  return NextResponse.json({
    total: catalog.length,
    limit: 250,
    catalog: catalog.slice(0, 250).map(({ raw, ...row }) => row),
    reviews: model.catalogReviews.slice(0, 100),
  });
}
