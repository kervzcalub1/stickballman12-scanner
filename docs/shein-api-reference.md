# SHEIN Open API — reference (self-operated store)

Pulled 2026-10-16 from the public doc portal. Field descriptions are SHEIN's own
(Chinese). To re-pull a page: `GET https://open.sheincorp.com/api/api/apiDoc/queryApiPublishDocDetailInfoById?id=<docId>&isLatest=true`
(note the doubled `/api/api/`; no login needed). Solution pages: `POST /api/page/detail?pageId=<uuid>`.
Menu: `GET /api/api/apiDoc/queryAllApiDocCategoryList?categoryType=1`.

## What we use it for, at a glance
| Job | Endpoint | Notes |
|---|---|---|
| Every listing | `product/query` | codes only (spu/skc/sku), 50/page, ≤50 000 per query |
| Size ↔ seller SKU, price, shelf | `goods/spu-info` | per SPU; `skuInfoList[].supplierSku` = OUR seller SKU; no stock |
| Read stock | `stock/stock-query` | ≤100 sku; `invType=VI` (merchant virtual stock); `warehouseType` dies 2026-12-31 |
| Write stock | `stock/change-inventory/v2` | ≤100 sku; `invType=VI`, `changeType=OVERWRITE`, **idempotencyKey required**; can't go below reserved+occupied. Old `gsp/goods/change-inventory` dies **2026-12-31** — use v2 |
| Our warehouse code | `msc/warehouse/list` | required on writes if >1 warehouse; only type 1 (merchant) is writable |
| Price | `product/price/save` | per sku per sub-site (`shein-us`); **omit specialPrice → it's set to 0**; never 0; status 2 = in review → wait for webhook before the next change |
| List / delist | `goods/modify-skc-shelf` | per SKC per site |
| Delete a shoe | `goods/check-deletable` → `DELETE goods/delete/{skcName}` → `goods-delete-logs/search` | per SKC; must be off the shelf on every site; ≤500/day; SHEIN reviews (refuses with an order in the last year); irreversible; frees the seller SKUs. Docs 3001904–3001906 (not copied below) |
| Orders | `order/order-list` → `order/order-detail` | list: ≤48 h window, **UTC+8 times**, pageSize ≤30; detail: ≤30 orders, `orderGoodsInfoList[]` = ONE row per unit with `sellerSku` (the size sold — see parent-SKU trap); only `stockMode=3` is ours |
| Unshipped | `newGoodsStatus` 1 待处理 / 2 待发货 / 7 待揽收 | 4 shipped, 5 signed, 6 refunded, 8 lost, 9 rejected |
| Returns | `return-order/list`, `/details` | |

Not for us: the **采购单 / Purchase Order** section (`order/purchase-order-infos`,
`shipping/*`, `idms/*`) is the managed-model "stock SHEIN's warehouse" flow.
Price/stock can NOT be changed via `goods/product/publishOrEdit` (rejected).

## POST `/open-api/openapi-business-backend/product/query` — 商品列表接口
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001239 · modes: 自运营, 全托管, 半托管, POP · QPS: 100 · updated 2025-07-17 11:56:50

该API支持查询已发布成功的商品列表数据，接口一次最多返回50000条数据。如果商家发布的商品数量超过50000条，请增加时间范围进行查询。

**Request body**

- `pageNum` integer  — 页面数量，默认：1
- `pageSize` integer  — 页面大小，默认：50
- `insertTimeEnd` string  — 商品上新的结束时间（商品首次审核通过），示例：2024-11-15 19:00:00
- `insertTimeStart` string  — 商品上新的开始时间（商品首次审核通过）示例：2024-11-15 20:00:00
- `updateTimeEnd` string  — 商品的更新结束时间（更新范围不仅是商品信息变动，包括系统内部更新时间）.示例：2024-11-15 19:00:00
- `updateTimeStart` string  — 商品的更新开始时间（更新范围不仅是商品信息变动，包括系统内部更新时间）.示例：2024-11-15 19:00:00

**Response body**

- `code` string  — 编码(0:success)
- `info` object  — 
  - `data` object[]  — 
    - `skcName` string  — skcName，skcName是SHEIN生成的系统编码
    - `skuCodeList` string[]  — sku维度数据，一个skc下最多40个sku；skuCode，skuCode是SHEIN生成的系统编码
    - `spuName` string  — spuName，spuName是SHEIN生成的系统编码
- `msg` string  — 错误信息
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/openapi-business-backend/product/query' \
--header 'language: zh-cn' \
--header 'x-lt-openKeyId: test' \
--header 'x-lt-signature: test' \
--header 'x-lt-timestamp: 1752724525405' \
--header 'Content-Type: application/json' \
--header 'Host: openapi-test01.sheincorp.cn' \
--data-raw '{
    "pageNum": 1, "pageSize": 50
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "data": [
            {
                "skcName": "sM22040955900525",
                "skuCodeList": [
                    "I065lggbkwpe",
                    "I065lggbejle",
                    "I065lggb9yr6",
                    "I065lggbivg3",
                    "I065lggbg9pt",
                    "I065lggbclpa",
                    "I065lggb4uy5"
                ],
                "spuName": "M2204095590"
            },
            {
                "skcName": "sM22120115814401",
                "skuCodeList": [
                    "I9bqt81qmsv0"
                ],
                "spuName": "M2212011581"
            }
        ]
    }
}
```

## POST `/open-api/goods/spu-info` — spu查商品详情(新)
Doc: https://open.sheincorp.com/documents/apidoc/detail/3002017 · modes: 自运营, 全托管, 半托管, POP · QPS: 100 · updated 2026-09-02 10:12:51

支持通过SPU查询商品信息。只有发布且已通过平台审核的SPU才能查到信息。; 可查信息：SPU/SKC/SKU维度品牌、名称、图片、属性、上架状态、价格、样品信息。; 不可查询信息：商品库存、属性排序。

**Request body**

- `languageList` string[] **req** — 语种列表。指的是商品名称、商品描述、属性名称会返回哪些语种信息。建议入参商家的默认语种，确保能拿到有效数据，默认语种通过商品发布规范 (https://open.sheincorp.com/documents/apidoc/detail/3001349)获取。; 最多可给5个语种，支持语种包括：英语:en、法语:fr、西班牙语:es、德语:de、中文简体:zh-cn、泰语:th、巴西葡语:pt-br、日语:ja、韩语:ko
- `spuName` string **req** — 平台生成的唯一编码。商品发布时会返回，或通过商品列表 (https://open.sheincorp.com/documents/apidoc/detail/3001239)接口获取。只有发布且已通过平台审核的SPU才能查到信息。

**Response body**

- `bbl` object  — bbl info
  - `info` object  — 
    - `*` object[]  — 
- `code` string **req** — success:0
- `info` object  — 商品详情
  - `brandCode` string  — 品牌code
  - `categoryId` int64  — 末级分类id
  - `ipCharacterList` object[]  — IP列表（目前1个商品只有1个IP）
    - `ipCharacterId` int64  — IP id
    - `ipCharacterName` string  — ip名称（英文）
    - `ipCharacterNameCn` string  — ip名称（中文）
  - `dimensionAttributeInfoList` object[]  — 尺寸属性（尺码表）。; 对应商品发布接口中的：size_attribute_list。
    - `attributeId` int64  — 属性ID
    - `attributeMultiList` object[]  — 属性ID的名称（包含多语言）。; 仅返回请求体中languageList中给出的语种。
      - `attributeName` string  — 属性名称
      - `language` string  — 语种
    - `dimensionAttributeAdditionList` object[]  — 尺码属性的手动输入值。; 对应商品发布接口中size_attribute_list -> attribute_extra_value。
      - `additionValue` string  — 手动输入值
      - `relateSaleAttributeId` int64  — 尺码属性关联的销售属性ID
      - `relateSaleAttributeValueId` int64  — 尺码属性关联的销售属性值ID
  - `productAttributeInfoList` object[]  — 商品属性列表。; 对应商品发布接口中的product_attribute_list（仅可入参attribute_type=3/4）。注意：此列表中包含了attribute_type=3/4（商品属性）、attribute_type=1（销售属性）信息。开发者需主动剔除下方skc/sku的销售属性，才能获得准确的商品属性。
    - `attributeId` int64  — 属性ID
    - `attributeMultiList` object[]  — 属性ID的多语言名称。; 仅返回请求体中languageList中给出的语种。
      - `attributeName` string  — 属性名称
      - `language` string  — 语种
    - `attributeValue` string  — 属性值（手动输入类型）。; 对应商品发布接口的product_attribute_list -> attribute_extra_value。
    - `attributeValueId` int64  — 属性值ID（下拉选择类型）。; 对应商品发布接口的product_attribute_list -> attribute_value_id。
    - `attributeValueMultiList` object[]  — 属性值的多语言名称。; 仅返回请求体中languageList中给出的语种。
      - `attributeValueName` string  — 属性值名称
      - `language` string  — 语种
  - `productMultiDescList` object[]  — 商品多语言描述。; 仅返回请求体中languageList中给出的语种。
    - `language` string  — 语种
    - `productDesc` string  — 商品描述
  - `productMultiNameList` object[]  — 商品多语言名称。; 仅返回请求体中languageList中给出的语种。
    - `language` string  — 语种
    - `productName` string  — 商品名称
  - `productVideoList` object[]  — 商品视频信息列表
    - `site` string  — 站点
    - `videoSourceUrl` string  — 视频链接
  - `productTypeId` int64  — 商品类型ID
  - `skcInfoList` object[]  — SKC明细信息
    - `attributeId` int64  — SKC销售属性ID
    - `attributeMultiList` object[]  — SKC销售属性多语言名称。; 仅返回请求体中languageList中给出的语种。
      - `attributeName` string  — 属性名称
      - `language` string  — 语种
    - `attributeValueId` int64  — SKC销售属性值ID
    - `attributeValueMultiList` object[]  — SKC销售属性值多语言名称。; 仅返回请求体中languageList中给出的语种。
      - `attributeValueName` string  — 属性值名称
      - `language` string  — 语种
    - `productMultiNameList` object[]  — SKC维度的商品名称多语言。; 仅返回请求体中languageList中给出的语种。
      - `language` string  — 语种
      - `productName` string  — 商品名称
    - `proofOfStockInfoList` object[]  — 库存证明文件信息
      - `fileName` string  — 文件名称
      - `type` integer  — 文件类型，1-图片 2-PDF
      - `url` string  — 文件链接
    - `shelfStatusInfoList` object[]  — 上下架信息
      - `firstShelfTime` datetime  — 首次上架时间
      - `lastShelfTime` datetime  — 最近上架时间
      - `lastUpdateTime` datetime  — 最近更新时间
      - `shelfStatus` integer  — 上下架状态:0下架;1上架
      - `siteAbbr` string  — 站点
    - `recycleInfoList` object[]  — 回收站状态信息
      - `recycleStatus` integer  — 回收站状态:0未回收，1已回收
      - `subSite` string  — 子站点
    - `siteDetailImageInfoList` object[]  — SKC站点详情图列表。; 对应商品发布接口中的site_detail_image_info_list
      - `imageGroupCode` string  — 图片组编码
      - `imageInfoList` object[]  — 详情图列表
        - `imageItemId` int64  — 图片ID
        - `imageSort` integer  — 图片顺序
        - `imageUrl` string  — 图片URL
      - `siteInfoList` object[]  — 详情图站点信息列表
        - `channel` string  — 渠道
        - `mainSite` string  — 主站
        - `site` string  — 子站
    - `sampleInfo` object  — 样品信息
      - `reserveSampleFlag` integer  — 是否需留样(1是 2否)
      - `sampleJudgeType` integer  — 审版类型
      - `sampleCode` string  — 样衣SKU
      - `spotFlag` integer  — 是否现货(1是 2否)
    - `skcImageInfoList` object[]  — SKC图片列表。; 对应商品发布接口的skc_list -> image_info。
      - `groupCode` string  — 图片组编码
      - `imageItemId` int64  — 图片ID
      - `imageMediumUrl` string  — 中图链接
      - `imageSmallUrl` string  — 小图链接
      - `imageType` string  — 图片类型
      - `imageUrl` string  — 原图链接
      - `sort` integer  — 图片排序
    - `skcName` string  — skcName，skcName是SHEIN生成的系统编码
    - `skuInfoList` object[]  — sku信息列表
      - `height` string  — 含包装的尺寸：高(cm); 此字段输出的是cm单位下的数值。如果需要换算成其他单位，可参考： https://open.sheincorp.com/documents/faq-detail/292 (https://open.sheincorp.com/documents/faq-detail/292)
      - `length` string  — 含包装的尺寸：长(cm); 此字段输出的是cm单位下的数值。如果需要换算成其他单位，可参考： https://open.sheincorp.com/documents/faq-detail/292 (https://open.sheincorp.com/documents/faq-detail/292)
      - `mallState` integer  — 商城销售状态，1-在售 2-停售
      - `stopPurchase` integer  — 采购状态，1-在采 2-停采
      - `saleAttributeList` object[]  — SKU销售属性列表
        - `attributeId` int64  — SKU销售属性ID
        - `attributeValueId` int64  — SKU销售属性值ID
        - `attributeValueMultiList` object[]  — SKU销售属性值多语言名称。; 仅返回请求体中languageList中给出的语种。
          - `attributeValueName` string  — 属性值名称
          - `language` string  — 语种
      - `productSkuAttributeList` object[]  — sku的普通属性列表（attribute_type=3/4）
        - `attributeId` int64  — 属性ID
        - `attributeMultiList` object[]  — 属性ID多语言名称
          - `attributeName` string  — 属性名
          - `language` string  — 语种
        - `attributeType` integer  — 属性类型
        - `attributeValueId` int64  — 属性值id
        - `attributeValueMultiList` object[]  — 属性值多语言名称
          - `attributeValueName` string  — 属性值名称
          - `language` string  — 语种
        - `additionValue` string  — 属性值（手动输入值）
      - `priceInfoList` object[]  — 售价信息列表
        - `basePrice` double  — 原价
        - `currency` string  — 币种
        - `site` string  — 子站点
        - `specialPrice` double  — 特价
      - `skuCode` string  — skuCode，skuCode是SHEIN生成的系统编码
      - `skuImageInfoList` object  — sku图片组信息
        - `groupCode` string  — 图片组编码
        - `imageItemId` int64  — 图片ID
        - `imageMediumUrl` string  — 中图链接
        - `imageSmallUrl` string  — 小图链接
        - `imageType` string  — 图片类型
        - `imageUrl` string  — 原图链接
        - `sort` integer  — 图片排序
      - `costInfoList` object[]  — 供货价信息列表
        - `costPrice` double  — 供货价
        - `currency` string  — 币种
      - `skuSupplierInfo` object  — sku供应信息
        - `supplierBarcodeEnabled` boolean  — 是否启用供应条码
        - `supplierBarcodeList` object[]  — 商家条码列表
          - `barcode_list` string[]  — 条码列表
          - `barcode_type` string  — 条码类型:EAN、UPC
      - `supplierSku` string  — 卖家SKU，创建商品时需要商家维护。
      - `weight` integer  — 含包装的尺寸：重量(g)。; 此字段输出的是g单位下的重量。如果需要换算成其他单位，可参考： https://open.sheincorp.com/documents/faq-detail/292 (https://open.sheincorp.com/documents/faq-detail/292)
      - `width` string  — 含包装的尺寸：宽(cm); 此字段输出的是cm单位下的数值。如果需要换算成其他单位，可参考： https://open.sheincorp.com/documents/faq-detail/292 (https://open.sheincorp.com/documents/faq-detail/292)
      - `quantityType` integer  — 件数类型。1-单件 2-同品多件
      - `quantityUnit` integer  — 件数单位。1-件 2-双
      - `quantity` integer  — 件数值
      - `packageType` integer  — 包装类型 0-空 1-软包装+软物 2-软包装+硬物 3-硬包装 4-真空
    - `srpPriceInfo` object  — 建议零售价信息
      - `currency` string  — 币种
      - `srpPrice` double  — 建议零售价
    - `supplierCode` string  — 卖家SKC编码，创建商品时需要商家维护，没有维护则不返回
  - `spuName` string  — spuName，spuName是SHEIN生成的系统编码
  - `spuImageInfoList` object  — spu图片列表。; 对应商品发布接口中的最外层image_info。
    - `groupCode` string  — 图片组编码
    - `imageItemId` int64  — 图片ID
    - `imageMediumUrl` string  — 中图链接
    - `imageSmallUrl` string  — 小图链接
    - `imageType` string  — 图片类型
    - `imageUrl` string  — 图片链接
    - `sort` string  — 图片排序
  - `supplierCode` string  — 卖家SPU编码，创建商品时需要商家维护，没有维护则不返回
- `msg` string  — message, success:OK
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/goods/spu-info' \
--header 'language: zh-cn' \
--header 'x-lt-openKeyId: test' \
--header 'x-lt-signature: test' \
--header 'x-lt-timestamp: 1752732946244' \
--header 'Content-Type: application/json' \
--header 'Host: openapi-test01.sheincorp.cn' \
--data-raw '{
    "languageList": [
        "zh-cn"],
    "spuName": "MM2404163183"
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "spuName": "MM2404163183",
        "categoryId": 1980,
        "productTypeId": 71,
        "brandCode": "",
        "supplierCode": "openapimx",
        "productMultiNameList": [
            {
                "productName": "Produto De Teste Openapi Mx custom valuesdsd",
                "language": "zh-cn"
            }
        ],
        "productMultiDescList": [
            {
                "productDesc": "",
                "language": "zh-cn"
            }
        ],
        "productAttributeInfoList": [
            {
                "attributeId": 40,
                "attributeMultiList": [
                    {
                        "attributeName": "适合类型",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 132,
                "attributeValueMultiList": [
                    {
                        "attributeValueName": "男朋友",
                        "language": "zh-cn"
                    }
                ],
                "attributeValue": null
            },
            {
                "attributeId": 39,
                "attributeMultiList": [
                    {
                        "attributeName": "面料弹性-id39",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 279,
                "attributeValueMultiList": [
                    {
                        "attributeValueName": "面料无弹性.",
                        "language": "zh-cn"
                    }
                ],
                "attributeValue": null
            },
            {
                "attributeId": 54,
                "attributeMultiList": [
                    {
                        "attributeName": "长度（54）",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 408,
                "attributeValueMultiList": [
                    {
                        "attributeValueName": "长款",
                        "language": "zh-cn"
                    }
                ],
                "attributeValue": null
            },
            {
                "attributeId": 90,
                "attributeMultiList": [
                    {
                        "attributeName": "袖长id90",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 409,
                "attributeValueMultiList": [
                    {
                        "attributeValueName": "长袖",
                        "language": "zh-cn"
                    }
                ],
                "attributeValue": null
            },
            {
                "attributeId": 87,
                "attributeMultiList": [
                    {
                        "attributeName": "尺寸",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 756,
                "attributeValueMultiList": [
                    {
                        "attributeValueName": "XXL",
                        "language": "zh-cn"
                    }
                ],
                "attributeValue": null
            },
            {
                "attributeId": 58,
                "attributeMultiList": [
                    {
                        "attributeName": "是否带里衬58",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 1001808,
                "attributeValueMultiList": [
                    {
                        "attributeValueName": "无内衬",
                        "language": "zh-cn"
                    }
                ],
                "attributeValue": null
            },
            {
                "attributeId": 87,
                "attributeMultiList": [
                    {
                        "attributeName": "尺寸",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 2147484569,
                "attributeValueMultiList": [
                    {
                        "attributeValueName": "323分",
                        "language": "zh-cn"
                    }
                ],
                "attributeValue": null
            },
            {
                "attributeId": 27,
                "attributeMultiList": [
                    {
                        "attributeName": "颜色",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 2147484570,
                "attributeValueMultiList": [
                    {
                        "attributeValueName": "黑色434",
                        "language": "zh-cn"
                    }
                ],
                "attributeValue": null
            }
        ],
        "dimensionAttributeInfoList": [],
        "spuImageInfoList": null,
        "skcInfoList": [
            {
                "skcName": "sMM24041631833322",
                "supplierCode": "openapimx",
                "sampleInfo": {
                    "sampleCode": "",
                    "reserveSampleFlag": 0,
                    "spotFlag": 0,
                    "sampleJudgeType": 2
                },
                "productMultiNameList": [
                    {
                        "productName": "Produto De Teste Openapi Mx custom valuesdsd",
                        "language": "zh-cn"
                    }
                ],
                "attributeId": 27,
                "attributeMultiList": [
                    {
                        "attributeName": "颜色",
                        "language": "zh-cn"
                    }
                ],
                "attributeValueId": 2147484570,
                "attributeValueMultiList": [
                    {
                        "attrib
```

## POST `/open-api/stock/stock-query` — 商家仓/SFS仓库存查询
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001695 · modes: 自运营, 全托管, SHEIN自营, 半托管, POP · QPS: 50 · updated 2026-04-27 20:38:29

支持通过sku、skc、spu查询库存数量; 请求参数：请注意，skuCodeList/skcNameList/spuNameList三个参数不能全部为空，至少传入一个; invType为新增参数，用于更准确地表达库存类型。原warehouseType参数将于2026年12月31日废弃下线，建议尽快切换至invType。过渡期内两个参数可同时使用，当同时传入时以invType为准。

**Request body**

- `skuCodeList` string[]  — SHEIN生成SKU 最多传100个，skuCodeList/skcNameList/spuNameList ，请确保三个参数有且只有1个不为空；
- `skcNameList` string[]  — SHEIN生成SKC，skuCodeList/skcNameList/spuNameList ，请确保三个参数有且只有1个不为空；
- `spuNameList` string[]  — SHEIN生成SPU，skuCodeList/skcNameList/spuNameList ，请确保三个参数有且只有1个不为空；
- `warehouseType` string **req** — 仓库类型；1:查备货在SHEIN仓的库存/ 2:查半托管，自主运营模式的虚拟库存/ 3:查代运营（全托管）、SHEIN自营模式的虚拟库存
- `invType` string  — 库存类型，PI：SHEIN仓实物库存，VI：商家虚拟库存，JI：商家JITJIT库存

**Response body**

- `code` string **req** — 响应编码 成功：0
- `info` object  — 
  - `goodsInventory` object[] **req** — 商品库存
    - `spuName` string **req** — SHEIN spu 编码
    - `skcName` string **req** — SHEIN skc 编码
    - `skuList` object[] **req** — sku库存数据
      - `skuCode` string **req** — SHEIN sku 编码
      - `totalInventoryQuantity` integer **req** — 查询sku仓库库存汇总
      - `totalLockedQuantity` integer **req** — 查询sku仓库锁定库存汇总
      - `totalTempLockQuantity` integer **req** — 查询sku仓库临时锁库存汇总
      - `totalUsableInventory` integer **req** — 查询sku仓库可用库存汇总
      - `totalOutOfStockQty` integer  — 查询已付款未转急采单的缺货需求数汇总；仅适用代运营，SHEIN自营的急采业务
      - `totalTransitQuantity` integer  — 查询sku仓库在途库存汇总
      - `warehouseInventoryList` object[] **req** — 具体仓库数据
        - `inventoryQuantity` integer **req** — 仓库库存数
        - `lockedQuantity` integer **req** — 仓库锁定库存
        - `tempLockQuantity` integer **req** — 仓库临时锁库存
        - `usableInventory` integer **req** — 仓库可用库存
        - `outOfStockQty` string  — 仓库已付款未转急采单的缺货需求数汇总；仅适用代运营，SHEIN自营的急采业务
        - `warehouseCode` string **req** — 仓库编码
        - `warehouseType` string **req** — 仓库类型
        - `transitQuantity` integer  — 仓库在途库存
- `msg` string  — 错误描述,成功：OK
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/stock/stock-query' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570817402' \
--data-raw '{
    "skuCodeList": ["I1omh30jb5ld"],
    "warehouseType": 2
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": [
        {
            "goodsInventory": [
                {
                    "spuName": "MM2402234440",
                    "skcName": "sMM24022344403001",
                    "skuList": [
                        {
                            "skuCode": "I1omh30jb5ld",
                            "totalInventoryQuantity": 999,
                            "totalLockedQuantity": 2,
                            "totalUsableInventory": 997,
                            "totalTempLockQuantity": 0,
                            "warehouseInventoryList": [
                                {
                                    "warehouseCode": "PS0618098174",
                                    "warehouseType": "2",
                                    "inventoryQuantity": 999,
                                    "lockedQuantity": 2,
                                    "usableInventory": 997,
                                    "tempLockQuantity": 0
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    ],
    "bbl": null
}
```

## POST `/open-api/gsp/goods/change-inventory` — 修改库存接口
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001692 · modes: 自运营, 半托管 · QPS: 50 · updated 2026-04-27 20:19:47

功能介绍：根据 shein sku 编码修改库存，输入 shein sku 编码和修改后的库存数量，返回状态以及修改失败的 shein sku 编码。; 适用应用：自主运营和半托管模式; 注意：如果店铺是多仓库的，调用接口需要传warehouseCode,否则会报错; 注意：此接口已经升级为更新商家库存接口v2 (https://open.sheincorp.com/documents/apidoc/detail/3001688)

**Request body**

- `updateSkuInventoryQuantityRequests` object[] **req** — 1次接口调用最多传100个sku，如需要修改库存的商品数量超过100，开发者需要多次调用接口
  - `changeInventoryQuantity` integer  — 商品的总库存；changeInventoryQuantity和saleInventory入参为必填，且只能填写一个； e.g. `673`
  - `skuCode` string **req** — SHEIN平台生成的SKU，仅限审核通过的SKU可以修改库存；审核失败的SKU不可用 e.g. `siqwersk74ujdjd`
  - `warehouseCode` string  — 仓库id，如果店铺有多个仓库则必传。通过商家仓列表查询 (https://open.sheincorp.com/documents/apidoc/detail/3000872)接口查看
  - `saleInventory` integer  — 更新可售库存；可售库存=可用库存+临时锁库存（下单未付款数）；changeInventoryQuantity和saleInventory入参为必填，且只能填写一个；

**Response body**

- `code` string **req** — response encoding succeeded: 0 e.g. `99002`
- `msg` string  — error description, success: OK e.g. `The request parameter is abnormal, please refresh and try again`
- `info` object  — 
  - `failedList` object[]  — 失败列表
    - `code` string  — 失败编码，失败原因，多个原因的情况下只返回一个错误码
    - `reason` string  — 失败原因，多个原因的情况下都会返回
    - `skuCode` string  — 编辑时上传的sku编码
  - `successList` object[]  — 更新成功的sku列表
    - `skuCode` string  — 编辑时上传的sku编码
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/gsp/goods/change-inventory' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570817402' \
--data-raw '{
  "updateSkuInventoryQuantityRequests": [
    
    {
      "changeInventoryQuantity": 66,
      "skuCode": "I569gfcaeopb",
      "warehouseCode": "PS30720142"
    },
    
    {
      "changeInventoryQuantity": 66,
      "skuCode": "I91iicgnj561",
      "warehouseCode": "PS56328250"
    },
    
    {
      "changeInventoryQuantity": 66,
      "skuCode": "mike gu test",
      "warehouseCode": "PS30720142"
    },
    
    {
      "changeInventoryQuantity": 5,
      "skuCode": "I33sb3sdgytd1",
      "warehouseCode": "PS6039317316"
    }
  ]
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "successList": [
            {
                "skuCode": "I569gfcaeopb",
                "reason": null,
                "code": null
            }
        ],
        "failedList": [
            {
                "skuCode": "I91iicgnj561",
                "reason": "商家仓库未匹配到--SKC非当前供应商所属",
                "code": "msc-update-stock-001"
            },
            {
                "skuCode": "mike gu test",
                "reason": "商品SKU不存在--SKC非当前供应商所属",
                "code": "msc-update-stock-004"
            },
            {
                "skuCode": "I33sb3sdgytd1",
                "reason": "商家仓库未匹配到--商品SKU不存在--SKC非当前供应商所属",
                "code": "msc-update-stock-001"
            }
        ]
    },
    "bbl": null,
    "traceId": "f1c83bbd7037613e"
}
```

## POST `/open-api/stock/change-inventory/v2` — 更新商家库存接口v2
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001738 · modes: 自运营, 半托管 · QPS: 50 · updated 2026-06-01 21:33:50

修改sku库存数量，支持自运营，半托管模式商家; 注意：; 1. 如果店铺是多仓库的，warehouseCode必填; 2. changeInventoryQuantity和saleInventory有且只有其中一个参数必填; 3. 支持修改商家虚拟库存、商家JIT虚拟库存; 4. SHEIN仓库存通过采购/退供等供应链业务管理增/减，不对外开放直接修改能力; 5. 原库存修改接口 /open-api/gsp/goods/change-inventory 将于 2026年12月31日下线。请尽快切换至新接口进行相关操作。过渡期内，新旧接口将同时保留功能支持。

**Request body**

- `updateSkuInventoryQuantityRequests` object[] **req** — 上限100个SKU
  - `idempotencyKey` string **req** — 业务幂等键。重复请求会被去重掉，避免重复修改库存。
  - `skuCode` string **req** — SHEIN平台生成的SKU，仅限审核通过的SKU可以修改库存；审核失败的SKU不可用
  - `invType` string **req** — 库存类型 VI：VIRTUAL_INVENTORY/虚拟库存； JI：JIT_INVENTORY/JIT虚拟库存；
  - `warehouseCode` string  — 修改商家虚拟库存：商家自有仓编码（多仓情况下必填）。 修改商家JIT虚拟库存：不需要填。
  - `changeType` string **req** — 总销售库存=可售数量+预占数量+占用数量。预占、占用库存已经被消费者订单占用不能修改。ADD：增加库存；SUB：减少库存；最大可减少数量=可售数量，超出范围报异常。OVERWRITE：覆盖库存；覆盖总销售数量=可售数量+预占数量+占用数量，最小覆盖数量不能低于预占数量+占用数量，否则按预占数量+占用数量覆盖数量来减少库存（即最多仅能把对应的未占用/预占的数量减掉）
  - `changeQuantity` integer **req** — 变更数量（正数）
  - `changeReason` string  — 变更原因

**Response body**

- `code` string **req** — 响应编码（0：成功；非0：失败） 具体见下方错误码描述
- `msg` string  — 错误描述信息
- `info` object  — 
  - `failedList` object  — 失败列表
    - `code` string  — 失败编码，失败原因，多个原因的情况下只返回一个错误码
    - `reason` string  — 失败原因，多个原因的情况下都会返回
    - `skuCode` string  — 编辑时上传的sku编码
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

## GET `/open-api/msc/warehouse/list` — 商家仓库列表查询
Doc: https://open.sheincorp.com/documents/apidoc/detail/3002013 · modes: 自运营, 半托管 · QPS: 50 · updated 2026-08-31 11:37:28

功能介绍：查询商家仓库列表信息。适用应用：自运营，半托管; ⚠️注意：商家如果有多个仓库，修改库存时必须传仓库id

**Response body**

- `code` string **req** — 响应编码 成功：0
- `info` object  — 
  - `list` object[] **req** — 商家仓库列表；商家如果有多个仓库，修改库存时必须传仓库id
    - `saleCountryList` string[] **req** — 销售国列表,枚举：BR、TH、US、MX、US、DE、FR、ES、IT、NL、PL、PT、SE、GB
    - `warehouseCode` string **req** — 商家仓库编码
    - `warehouseName` string **req** — 仓库名称,根据入参语种返回,默认EN
    - `warehouseType` string **req** — 仓库类型；1：商家仓；2：认证仓；只有商家仓的商品可以修改库存
    - `authServiceCode` string  — 认证仓code；仅认证仓显示
    - `authServiceName` string  — 认证仓名称；仅认证仓显示
    - `countrySiteDefaultList` object  — 销售站点及默认仓信息
      - `countrySiteCode` string  — 子站点编码
      - `defaultFlag` integer  — 是否默认仓;0-非默认,1-默认
- `msg` string  — 错误描述,成功：OK
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request GET 'https://openapi.sheincorp.com/open-api/msc/warehouse/list' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570729613' \
--data-raw ''
```

**Response example**
```
{
  "code": "0",
  "msg": "OK",
  "info": {
    "list": [
      {
        "warehouseCode": "PS0426919682",
        "warehouseName": "Girona Warehouse",
        "saleCountryList": [
          "FR",
          "ES",
          "IT",
          "NL",
          "PL"
        ],
        "createType": 3,
        "warehouseType": 1,
        "authServiceCode": "",
        "authServiceName": ""
      },
      {
        "warehouseCode": "PS1993127180",
        "warehouseName": "EU Warehouse",
        "saleCountryList": [
          "DE",
          "FR",
          "ES",
          "IT",
          "NL",
          "PL"
        ],
        "createType": 3,
        "warehouseType": 1,
        "authServiceCode": "",
        "authServiceName": ""
      },
      {
        "warehouseCode": "PS8428226538",
        "warehouseName": "英国",
        "saleCountryList": [
          "GB"
        ],
        "createType": 1,
        "warehouseType": 1,
        "authServiceCode": "",
        "authServiceName": ""
      }
    ]
  },
  "bbl": null,
  "traceId": "38090e8ea1bc33fa"
}
```

## POST `/open-api/openapi-business-backend/product/price/save` — 更新商品售价
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001940 · modes: 自运营 · QPS: 40 · updated 2026-08-03 11:05:50

该API支持更新商品的售价信息，调整价格会有价格审核机制，需要重点关注返回参数中的status，只有修改成功之后才能再次发起修改价格，如果返回参数status=2待审核，需通过webhook：商品涨价审批结果通知 (https://open.sheincorp.com/documents/apidoc/detail/3000750)，拿到结果之后才能再次修改价格。

**Request body**

- `productPriceList` object[]  — 商品价格信息列表, 最大长度100
  - `productCode` string **req** — 传sku_code，sku_code是商品发布SHEIN生成的系统编码
  - `currencyCode` string **req** — 币种，商品在SHEIN平台使用的售卖币种，如BRL, THB, USD, MXN. 具体币种可查询店铺站点和币种信息（新） (https://open.sheincorp.com/documents/apidoc/detail/3000819)获取
  - `shopPrice` double **req** — 原价。; 发起涨价前，请先通过接口确认商品能否涨价（商品参与营销活动后可能无法涨价）：/open-api/goods/searchProduct，activityLockList-priceLockType
  - `specialPrice` double  — 特价 ，注：特价不传时，默认特价更新为0！
  - `site` string **req** — 站点-只能传子站点。例如shein-us
  - `riseReason` string  — 涨价原因。枚举:1-商品成本上涨,2-物流履约费用上涨,3-活动结束恢复价格,4-其他,5-物流履约费用上涨（物流规则调整）

**Response body**

- `code` string **req** — 响应码 0: 正常
- `info` object  — 响应信息
  - `data` object[]  — 
    - `success` boolean  — 是否成功 ture:成功 false:失败
    - `message` string  — message
    - `productCode` string  — sku_code是商品发布SHEIN生成的系统编码
    - `site` string  — 站点
    - `status` integer  — 状态码，0 失败，1 成功，2 待审核
- `msg` string  — 响应描述
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/openapi-business-backend/product/price/save' \
--header 'language: zh-cn' \
--header 'x-lt-openKeyId: test' \
--header 'x-lt-signature: test' \
--header 'x-lt-timestamp: 1752734980846' \
--header 'Content-Type: application/json' \
--header 'Host: openapi-test01.sheincorp.cn' \
--data-raw '{
    "productPriceList": [{
        "currencyCode": "MXN",
        "productCode": "I11mesukkwwr",
        "site": "shein-mx",
        "shopPrice": 1,
        "riseReason":null,
        "specialPrice":null


    }]
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "data": [
            {
                "success": true,
                "message": "价格调整成功",
                "productCode": "I11mesukkwwr",
                "site": "shein-mx"
                "status":1
            }
        ]
    }
}
```

## POST `/open-api/goods/modify-skc-shelf` — 商品上下架
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001939 · modes: 自运营, 半托管, POP · QPS: 40 · updated 2026-08-03 11:02:08

该API支持根据SKC维度修改商品上下架状态

**Request body**

- `skc_site_info_list` object[] **req** — 上下架站点信息，1次调用最多支持100条数据。; 重要：对于【同SKC+同站点】的操作，必须间隔20分钟以上，否则将操作失败。请不要高频对相同数据发起操作。
  - `shelf_state` integer **req** — 上下架操作；1.上架,2.下架; 重要：发起下架操作前，请先通过接口确认SKC当前能否下架（当商品参加营销活动时可能无法下架）：/open-api/goods/searchProduct，activityLockList-shelfLockType
  - `site_list` string[] **req** — 需要修改的商品站点
  - `skc_name` string **req** — skc_name，skc_name是商品发布SHEIN生成的系统编码

**Response body**

- `bbl` object  — bbl
  - `info` object  — 
    - `*` object[]  — 
- `code` string **req** — 成功: 0
- `info` object  — 
  - `failure_count` integer  — 失败数
  - `failure_results` object[]  — 失败详情
    - `code` string  — 错误码
    - `identity` string  — 返回失败的skc_name
    - `line_index` integer  — 无需关注
    - `msg` string  — 错误信息
  - `success_count` integer  — 成功数
  - `total_count` integer  — 总数量
- `msg` string  — 错误描述, 成功: OK
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/goods/modify-skc-shelf' \
--header 'language: zh-cn' \
--header 'x-lt-openKeyId: test' \
--header 'x-lt-signature: test' \
--header 'x-lt-timestamp: 1752733538805' \
--header 'Content-Type: application/json' \
--header 'Host: openapi-test01.sheincorp.cn' \
--data-raw '{
    "skc_site_info_list": [
        {
            "shelf_state": 2,
            "site_list": [
                "shein-fr"
            ],
            "skc_name":"sMM23072039123259"
        }
    ]
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "success_count": 1,
        "failure_count": 0,
        "total_count": 1,
        "failure_results": []
    },
    "bbl": null
}
```

## POST `/open-api/goods/query-site-list` — 店铺查询站点列表
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001249 · modes: 自运营, 全托管, 半托管, POP · QPS: 40 · updated 2025-07-17 14:45:31

该API支持查询店铺售卖的站点和币种信息

**Response body**

- `bbl` object  — bbl
  - `info` object  — 
    - `*` object[]  — 
- `code` string **req** — result(success: 0)
- `info` object  — 
  - `data` object[]  — data
    - `main_site` string  — 主站点
    - `main_site_name` string  — 主站点名称
    - `sub_site_list` object[]  — 子站点
      - `currency` string  — 币种
      - `site_abbr` string  — 站点缩写
      - `site_name` string  — 站点名称
      - `site_status` integer  — 站点店铺状态：0：未启用，1：启用
      - `store_type` integer  — 店铺模式：1-平台类型，2-自营类型
      - `symbol_left` string  — 货币左侧符号
      - `symbol_right` string  — 货币右侧符号
  - `meta` object  — meta
    - `count` integer  — 
    - `customObj` object  — 
- `msg` string  — Error description, success: OK
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/goods/query-site-list' \
--header 'language: zh-cn' \
--header 'x-lt-openKeyId: test' \
--header 'x-lt-signature: test' \
--header 'x-lt-timestamp: 1752733538805' \
--header 'Content-Type: application/json' \
--header 'Host: openapi-test01.sheincorp.cn' \
--data-raw ''
```

**Response example**
```
{
  "code": "0",
  "msg": "OK",
  "info": {
    "data": [
      {
        "main_site": "shein",
        "main_site_name": "SHEIN",
        "sub_site_list": [
          {
            "site_name": "SHEIN法国站",
            "site_abbr": "shein-fr",
            "site_status": 1,
            "store_type": 1,
            "currency": "EUR",
            "symbol_left": "",
            "symbol_right": "€"
          },
          {
            "site_name": "SHEIN西班牙站",
            "site_abbr": "shein-es",
            "site_status": 1,
            "store_type": 1,
            "currency": "EUR",
            "symbol_left": "",
            "symbol_right": "€"
          },
          {
            "site_name": "SHEIN德国站",
            "site_abbr": "shein-de",
            "site_status": 1,
            "store_type": 1,
            "currency": "EUR",
            "symbol_left": "",
            "symbol_right": "€"
          },
          {
            "site_name": "SHEIN意大利站",
            "site_abbr": "shein-it",
            "site_status": 1,
            "store_type": 1,
            "currency": "EUR",
            "symbol_left": "",
            "symbol_right": "€"
          },
          {
            "site_name": "SHEIN荷兰站",
            "site_abbr": "shein-nl",
            "site_status": 1,
            "store_type": 1,
            "currency": "EUR",
            "symbol_left": "",
            "symbol_right": "€"
          },
          {
            "site_name": "SHEIN波兰站",
            "site_abbr": "shein-pl",
            "site_status": 1,
            "store_type": 1,
            "currency": "PLN",
            "symbol_left": "",
            "symbol_right": "zł"
          },
          {
            "site_name": "SHEIN奥地利站",
            "site_abbr": "shein-at",
            "site_status": 1,
            "store_type": 1,
            "currency": "EUR",
            "symbol_left": "",
            "symbol_right": "€"
          }
        ]
      }
    ],
    "meta": {
      "count": 1,
      "customObj": null
    }
  },
  "bbl": null,
  "traceId": "bbfb5e663a06cfee"
}
```

## POST `/open-api/order/order-list` — 请求订单列表
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001921 · modes: 自运营, 半托管 · QPS: 100 · updated 2026-07-09 19:46:04

通过该接口获取订单列表；该接口适用自主运营，半托管的应用；也可以使用webhook中的订单同步通知 (https://open.sheincorp.com/documents/msgdoc/detail/3000790)感知最新的订单信息；; 支持通过订单的创建时间和更新时间查询；查询条件startTime和endTime的时间范围限制为48小时，查询结果总数限制为10000条；如查询范围内的订单超过10000条，需要取最后一次查询的最后一笔的订单创建时间作为下一个查询的 "startTime"。; 注意：接口请求时间和响应时间的时区为 UTC+8（北京时间）

**Request body**

- `queryType` integer **req** — 查询类型：1：根据订单下发时间查询/2：根据订单更新时间查询（当下发订单时会将下发时间同步到更新时间）； e.g. `0`
- `startTime` string **req** — 开始时间;示例：2024-12-12 15:38:29（UTC+8）。startTime和endTime的时间范围限制为48小时，查询结果总数限制为10000条；如查询范围内的订单超过10000条，需要取最后一次查询的最后一笔的订单时间作为下一个查询的 "startTime"。 e.g. `2023-01-30 15:38:29`
- `endTime` string **req** — 结束时间;示例：2024-12-12 15:38:29（UTC+8）。startTime和endTime的时间范围限制为48小时，查询结果总数限制为10000条；如查询范围内的订单超过10000条，需要取最后一次查询的最后一笔的订单时间作为下一个查询的 "startTime"。 e.g. `2023-01-30 15:38:29`
- `page` integer **req** — 分页的页码 e.g. `0`
- `pageSize` integer **req** — 每页返回的条数；请设置1～30的整数 e.g. `0`
- `orderStatus` integer  — 订单状态：1：待处理/ 2：待发货/ 3：待shein发货/ 4：已发货/ 5：已签收/ 6：用户已退款/ 7：待揽收/ 8：已报损/ 9：已拒收 e.g. `0`
- `queryOrderType` integer  — 查询对应发货仓类型的订单；1:认证仓发货订单/ 2:SHEIN仓发货订单 / 3:商家仓发货订单/ 4: 所有订单；; 不传的情况下，巴西商家会返回商家仓发货订单，其他国家市场会返回SHEIN仓发货、商家仓发货订单
- `cteInvoiceStatus` integer  — 巴西市场CTE开票状态；1:订单下所有包裹（取消的除外）已完成开票/ 2:订单下的包裹存在未完成开票
- `nfeInvoiceStatus` integer  — 巴西市场NFE开票状态;1：已完成NFE开票/ 2：未完成NFE开票（对于巴西卖家，当订单发票信息通过回传发票信息同步后，状态从2变为1）/ 3：待重传NFE发票/ 4：无需开NFE发票

**Response body**

- `code` integer  —  e.g. `0`
- `msg` string  — 错误信息描述 e.g. `OK`
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪
- `info` object **req** — 响应数据
  - `count` integer  — 响应条数 e.g. `1`
  - `orderList` object[] **req** — 订单信息列表
    - `orderNo` string  — 订单号 e.g. `GSHNMD35M00HHAC`
    - `orderStatus` string  — 订单状态：1：待处理/ 2：待发货/ 3：待shein发货/ 4：已发货/ 5：已签收/ 6：用户已退款/ 7：待揽收/ 8：已报损/ 9：已拒收 e.g. `1`
    - `orderCreateTime` string  — 订单下发时间（UTC+8）；示例2023-04-19 03:37:01 e.g. `2022-02-22 17:26:46`
    - `orderUpdateTime` string  — 订单更新时间（UTC+8）；示例2023-04-19 03:37:01；（当下发订单时会将下发时间同步到更新时间） e.g. `2022-05-16 20:11:12`

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/order/order-list' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570849017' \
--data-raw '{
  "queryType": 1,
  "startTime": "2023-08-09 12:00:00",
  "endTime": "2023-08-10 23:59:59",
  "page": 1,
  "pageSize": 30,
  "orderStatus": 1
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "count": 2,
        "orderList": [
            {
                "orderNo": "GSON8H44Y0004CU",
                "orderStatus": "1",
                "orderCreateTime": "2023-08-09 18:03:04",
                "orderUpdateTime": "2023-08-10 17:29:34"
            },
            {
                "orderNo": "H23081033497436161",
                "orderStatus": "1",
                "orderCreateTime": "2023-08-10 17:45:01",
                "orderUpdateTime": "2023-08-11 14:36:34"
            }
        ]
    }
}
```

## POST `/open-api/order/order-detail` — 请求订单详情
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001915 · modes: 自运营, 半托管 · QPS: 300 · updated 2026-07-03 21:03:13

通过该接口获取自主运营、半托管商家的订单详情；接口中返回的时间均为北京时间（UTC+8）；; 如何对接订单请查看ERP订单履约方案 (https://open.sheincorp.com/documents/system/b86df826-638d-4128-9f5e-c7b20d8cf28e)；

**Request body**

- `orderNoList` string[] **req** — 订单号列表；最多30条；

**Response body**

- `code` string  — 响应码 e.g. `0`
- `msg` string  — 错误信息描述 e.g. `OK`
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪
- `info` object[] **req** — 响应数据
  - `orderNo` string  — 订单号 e.g. `GSHNN960700HHA8`
  - `orderStatus` integer  — 订单状态；1：待处理/ 2：待发货/3：待SHIEIN发货/ 4：已发货/ 5：已签收/ 6：用户已退款/ 7：待揽收/ 8：已报损（使用SHEIN集成物流履约的场景下，物流商报告包裹破损或丢失）/ 9：已拒收（买家拒收包裹）； e.g. `1`
  - `stockMode` integer  — 库存模式：1-SHEIN自营库存，2-库存到SHEIN仓库（SHEIN履行服务），3-不入库存到SHEIN仓。开发者仅需处理 stockMode=3 的订单，1和2无需开发者介入。
  - `orderType` integer  — 是否是换货订单；1：正常订单/ 2：换货订单/ 4：认证仓转自发货订单(认证仓无货或者其它问题)/ 5：认证仓订单（类型5的订单为认证仓的订单，请勿导出地址、打印面单或上传运单号）；换货订单如何处理可查看：换货场景说明 (https://open.sheincorp.com/documents/system/14b4ecf0-8e51-4cfc-bdcb-d4bd26c8e9ae)； e.g. `1`
  - `printOrderStatus` integer  — 订单是否可处理；1：可处理/ 2：不可处理；等于1则可进行“打印面单”和“导出地址”操作，否则需要根据unProcessReason的值进行处理； e.g. `2`
  - `unProcessReason` integer[]  — 订单问题说明；1、5、7、8: 系统处理/ 2: 订单存在问题，客服正在验证处理/ 3: 巴西订单需要同步发票/ 4: 订单未生成包裹/未预测成功/ 6、9: 部分商品缺货/ 10、11: 尚未设置卖家仓库/ 12: 需要调用 API 确认拆包或取消拆包/13：CTE发票开票中，可以接入webhook：invoice_status_notice (https://open.sheincorp.com/documents/msgdoc/detail/3001082)，发票开具成功后会有消息通知
  - `isOverLimitOrder` integer  — 是否为超限拆包订单;1：是/ 2：否；等于1，卖家需要确认拆包 (https://open.sheincorp.com/documents/apidoc/detail/3000608)或取消拆包 (https://open.sheincorp.com/documents/apidoc/detail/3000609)
  - `optionalLogisticsList` integer[]  — 可选物流发货方式：1-平台合作物流发货，2-商家自发货；若两种方式均支持，返回[1,2]。; 业务场景示例：; [1]：只能走平台物流（美国、中东、巴西、墨西哥等），需结合 orderPlaceType 判断具体下单方式（平台指定物流或在线下单）; [2]：只能自发货（日本、韩国等，导出地址+上传运单号）; [1,2]：商家可自由选择平台物流或自发货（欧洲等） e.g. `1`
  - `orderLogisticsType` integer  — 订单已选发货方式：0-未选，1-已选平台合作物流发货，2-已选商家自发货。主要用于 optionalLogisticsList=[1,2] 的场景，记录商家在平台物流和自发货之间的最终选择；订单初始状态为0（未选）。 e.g. `0`
  - `orderPlaceType` integer  — 平台物流的下单方式，仅当 optionalLogisticsList 包含1时有意义。1-平台指定物流（由平台分配物流渠道，商家不可选择）；2-在线下单（商家从平台合作的物流渠道中自行选择并下单）。; 业务场景示例：; =1：平台指定物流（巴西、墨西哥市场）; =2：在线下单（美国、中东、欧洲市场） e.g. `2`
  - `isCod` integer  — 是否为货到付款订单；1：是/ 2：否；; 现在只有中东开展该业务； e.g. `2`
  - `billNo` string  — 原订单号；换单的场景下可以关联到原始订单号；
  - `salesSite` string  — 销售站点；如：shein-br
  - `deliveryServiceType` integer  — 订单配送服务类型(1:送货上门, 2:送货到店)
  - `orderTag` integer  — 订单标签；0：正常订单/ 1：问题订单/ 4：特殊订单/ 5：紧急订单 e.g. `0`
  - `orderLabels` string[]  — 订单标签：easy_delivery_uncollected-易引起妥投未收争议
  - `orderGoodsInfoList` object[] **req** — 订单商品信息
    - `goodsId` bigint  — 每件商品的唯一ID。如果一个 SKU 有多件，每一件的goodsId都是唯一的 e.g. `2226462748377089`
    - `skuCode` string  — SHEIN sku编码 e.g. `I95gom5fbt1s`
    - `skc` string  — SHEIN skc编码 e.g. `sM22031112223613`
    - `goodsSn` string  — 商家spu编码 e.g. `1`
    - `sellerSku` string  — 商家sku编码
    - `goodsStatus` integer  — （已弃用！！）商品状态 e.g. `1`
    - `newGoodsStatus` integer  — 订单商品状态；1：待处理/ 2：待发货/ 4：已发货/ 5：已签收/ 6：用户已退款/ 7：待揽收/ 8：已报损/ 9：已拒收
    - `goodsExchangeTag` long  — 商品换货标识：1：未换货/ 2：被换商品/ 3：换来商品/ 4：删除换货；仅当值为1（未换货）或3（换来商品）时需要履约发货；值为2（被换商品）或4（删除换货）时无需履约。换货订单如何处理请查看订单换货场景说明 (https://open.sheincorp.com/documents/system/14b4ecf0-8e51-4cfc-bdcb-d4bd26c8e9ae) e.g. `1`
    - `timeOutList` object[]  — 商品超时自动取消信息； 商家自发货的场景会同时返回1，2，100枚举值； SHEIN集成物流揽收的场景会同时返回，1，7，100枚举值；
      - `timeOutTime` datetime  — 超时取消时间；格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ
      - `timeOutType` integer  — 超时类型枚举值，分为单节点考核和全链路考核：; 单节点考核（考核某一状态的停留时间）：; 1：待处理超时。未在时限内从 newGoodsStatus=1 流转到 newGoodsStatus=2 则取消。; 2：待发货超时（optionalLogisticsList 包含2，商家自发货场景）。未在时限内从 newGoodsStatus=2 流转到 newGoodsStatus=4 则取消。; 7：待揽收超时（optionalLogisticsList 包含1，平台合作物流场景）。未在时限内从 newGoodsStatus=2 流转到 newGoodsStatus=4 则取消。; 100：待签收超时。未在时限内流转到 newGoodsStatus=5 则取消。; 全链路考核（考核多节点累计耗时，各单节点未超时全链路仍可能超时）：; 35：分单至发货。从获取订单到完成发货的总时限。; 36：至揽收。从获取订单到SHEIN完成揽收的总时限。; 同一订单可能同时存在两类规则。
    - `skuAttribute` object[] **req** — 多语种的SKU属性信息
      - `attrValueId` string  — 属性值ID集合 e.g. `78,1000105`
      - `attrName` string  — 属性值名称集合 e.g. `杏色-春`
      - `language` string  — 语种 e.g. `CN`
    - `goodsTitle` string  — 产品名称；卖家在SHEIN商城展示的SPU名称
    - `spuPicURL` string  — SPU主图URL e.g. `http://imgdeal-test01.shein.com/gspCenter/2022/03/11/1341-1876.jpg`
    - `goodsWeight` integer  — 商品重量 e.g. `211111`
    - `storageTag` integer  — 库存标签：1：已占库存（无异常）/ 2：无库存可占（库存占用异常）/ 3：无货（不履约，不再占用库存） e.g. `1`
    - `performanceTag` integer  — 发货标识： 1：已发货/ 2：未发货/ 3：已签收 e.g. `0`
    - `beExchangeEntityId` bigint  — 被换商品ID e.g. `0`
    - `orderCurrency` string  — 客户下单币种 e.g. `USD`
    - `saleCurrency` string  — 销售币种（仅适用半托管）
    - `sellerCurrencyPrice` decimal  — 订单的商品价格，前台销售价格（半托管商家可忽略） e.g. `34.2`
    - `costPrice` decimal  — 商品供货价，仅适用半托管模式
    - `orderCurrencyStoreCouponPrice` decimal  — 店铺优惠券金额； e.g. `0`
    - `orderCurrencyPromotionPrice` decimal  — 活动优惠金额（半托管商家可忽略） e.g. `0`
    - `settleCurrencyPromotionPrice` decimal  — 活动提报优惠金额；商品因参加营销活动或使用促销工具，供货价降低的金额，仅适用半托管模式
    - `commission` decimal  — 佣金，仅适用自主运营模式 e.g. `0.342`
    - `commissionRate` decimal  — 佣金比例，仅适用自主运营模式 e.g. `0.01`
    - `serviceCharge` decimal  — 可忽略 e.g. `0`
    - `performanceServiceCharge` decimal  — SHEIN 向卖家收取的履单服务费用 e.g. `0`
    - `estimatedIncome` decimal  — 预计收入；; 1、自主运营模式下，预计收入=sellerCurrencyPrice-orderCurrencyStoreCouponPrice-orderCurrencyPromotionPrice-performanceServiceCharge-commission; 2、半托管模式且平台代缴欧洲vat税费，预计收入=costPrice-settleCurrencyPromotionPrice-performanceServiceCharge-orderCurrencyStoreCouponPrice; 3、半托管模式且商家自行缴纳欧洲vat税费，预计收入= =costPrice-settleCurrencyPromotionPrice-performanceServiceCharge-orderCurrencyStoreCouponPrice+sellerRealTax e.g. `33.85`
    - `spuName` string  — SHEIN spu编码
    - `saleTax` decimal  — 消费税，在美国，根据美国税法，向买家征收的消费税。由shein代收代缴，不纳入预计收入结算
    - `sellerRealTax` decimal  — 欧洲vat税费（平台代扣代缴且会给予补贴，商家可忽略）
    - `mxTaxPrice` decimal  — 墨西哥卖家税费；
    - `commissionSaleTax` decimal  — 佣金消费税，仅适用自主运营
    - `warehouseCode` string  — 商家仓ID
    - `warehouseName` string  — 商家仓名称
    - `sellerCurrencyDiscountPrice` decimal  — 商品折后价，仅自主运营模式返回
    - `unpackingGroupNo` string  — 拆包分组号；当订单有绑定“超限拆包订单标签”， 且已获取TMS拆包建议或卖家已进行自主拆包，该字段才有值
    - `unpackingGroupInvoiceStatus` string  — 发票状态;1：已开票/ 2：未开票/ 3：待重新上传/ 对于 BR 卖家，当订单发票信息通过回传发票信息 (https://open.sheincorp.com/zh/documents/apidoc/detail/3000616)同步后，状态将从 2（未开票）变为 1（已开票）
    - `customizationFlag` integer **req** — 是否定制商品；1：普通品;/ 2：定制品
    - `customizationInfo` object  — 定制品明细(customizationFlag=2时有值)
      - `customInfoId` string  — 定制加购ID
      - `texts` string[]  — 定制文本信息
  - `receiveMsg` object  — 订单收件区域信息,非平台指定物流时有值；
    - `city` string  — 城市
    - `country` string  — 国家
    - `province` string  — 州（省）
    - `postCode` string  — 邮编
  - `packageWaybillList` object[] **req** — 包裹的运单信息
    - `packageNo` string  — 包裹号码 e.g. `G220317503939074`
    - `deliveryNo` string  — 运单包裹号；一般情况下运单包裹号=包裹号，但在合并订单发货时，运输号和包裹号不同；可使用该字段打印在线下单的面单；
    - `waybillNo` string  — 运单号。若订单经SHEIN仓中转再派送至消费者，此处为尾程派送运单号（非商家发货至SHEIN仓的运单号）。
    - `carrier` string  — 物流商名称
    - `carrierCode` string  — 物流商的唯一编码
    - `productInventoryList` object[] **req** — 订单商品ID列表
      - `productId` string  — 若“包裹号”有值，则取包裹号下所有的商品ID 若“包裹号”为空，则判断“拆包分组号”是否有值， a）若有值，则取拆包分组号下的所有商品ID b）若无值，则无需返回 e.g. `1462`
    - `packageLabel` string  — 返回该包裹最新的标签；1：丢件包裹/ 2：滞留包裹/
    - `sortingCode` string  — 分拣代码，无需关注
    - `expressSortingCode` string  — 渠道商简码
    - `isCutOffSeller` int64  — 标记这个订单是否是截单
  - `invoiceStatus` integer  — 发票上传状态;1：已开票/ 2：未开票（对于巴西卖家，当订单发票信息通过回传发票信息 (https://open.sheincorp.com/documents/apidoc/detail/3000616)同步后，状态从2变为1）/ 3：待重传/ 4：无需开票 e.g. `2`
  - `cteInvoiceStatus` integer  — 巴西市场CTE开票状态；1:订单下所有包裹（取消的除外）已完成开票/ 2:订单下的包裹存在未完成开票，开票状态可订阅webhook：/invoice_status_notice (https://open.sheincorp.com/documents/msgdoc/detail/3001082)
  - `packageInvoiceProblems` object[]  — 订单包裹发票问题
    - `problemCode` string  — 问题code
    - `problemDescEnglish` string  — 问题描述（英文）
    - `problemField` string  — 问题字段
    - `proposalEnglish` string  — 建议方案（英文）
    - `packageNo` string  — 卖家包裹号
  - `orderCurrency` string  — 订单货币 e.g. `USD`
  - `saleCurrency` string  — 销售币种
  - `settleActuallyPrice` decimal  — 销售价格。仅品牌商家返回该信息
  - `productTotalPrice` decimal  — 商品总金额 e.g. `68.4`
  - `totalCostPrice` decimal  — 供货价总金额，仅适用半托管模式
  - `storeDiscountTotalPrice` decimal  — 店铺优惠券总金额； e.g. `0`
  - `promotionDiscountTotalPrice` decimal  — 活动优惠总金额 e.g. `0`
  - `totalSettleCurrencyPromotionPrice` decimal  — 活动提报优惠总金额，仅适用半托管模式
  - `totalCommission` decimal  — 总佣金，仅适用自主运营模式 e.g. `0.684`
  - `totalServiceCharge` decimal  — 可忽略 e.g. `0`
  - `totalPerformanceServiceCharge` decimal  — 总履约服务费 e.g. `0`
  - `estimatedGrossIncome` decimal  — 预计总收入 e.g. `67.7`
  - `totalSaleTax` decimal  — 总消费税
  - `totalSellerRealTax` decimal  — 总欧洲VAT税费
  - `totalMxTaxPrice` decimal  — 总墨西哥卖家税费
  - `sellerShippingFee` decimal  — 买家支付的运费，平台返回给商家的收入（仅部分模式下的商家会返回）；
  - `performanceBillingType` integer  — 履约服务费计费维度：0-默认值1-商品2-包裹(仅需要收履约服务费的订单会返回，非在线下单订单，会返回空；存在部分历史订单返回为空)
  - `orderMsgUpdateTime` string  — 订单信息更新时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `orderTime` string  — 买家下单时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `paymentTime` string  — 买家付款时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `orderAllocateTime` string  — 订单下发时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ），即商家可查看到订单的时间 e.g. `2022-03-17 06:05:16.000-0300`
  - `printingTime` string  — 打印面单时间
  - `scheduleDeliveryTime` string  — 预约发货时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ），仅使用SHEIN集成物流发货场景
  - `sellerDeliveryTime` string  — 卖家交货时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `pickUpTime` string  — 物流取件时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `orderReceiptTime` string  — 买家签收时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `requestPrintTime` string  — 要求打单时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）,使用详情见FAQ (https://open.sheincorp.com/zh/documents/faq-detail/100)
  - `needDeliveryTime` string  — 要求发货时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `requestHandoverTime` string  — 要求揽收时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）,使用详情见FAQ (https://open.sheincorp.com/documents/faq-detail/100)
  - `requestSignTime` string  — 要求签收时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `orderRejectionTime` string  — 订单拒绝签收时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `orderReturnTime` string  — 订单退款时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `orderReportedLossTime` string  — 订单报损时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `warehouseDeliveryTime` string  — 仓库交货时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `expectedCollectTime` string  — 期望揽收时间（格式：yyyy-MM-dd'T'HH:mm:ss.SSSZ）
  - `salesArea` integer  — 销售范围；1：本土销售/ 2：跨境销售
  - `storeCode` integer  — 店铺code
  - `paymentInfo` object  — 
    - `payNo` string  — 主支付单号
    - `payMethod` string  — 支付方式03:CREDIT 04:DEBIT 17:pix 18:PayPal 01:boleto 99:others
    - `installmentFlag` integer  — 分期标识 1:分期 0:不分期
    - `cardType` string  — 卡种 01:visa 02:mastercard 03:AMERICAN_EXPRESS 04:Sorocred 05:Diners Club 06:Elo 07:Hipercard 08:Aura 09:Cabal 99:others
    - `channelPayNo` string  — 渠道单号
    - `cnpj` string  — 固定值 Moda Mundial (Subacquirer) CNPJ number: 50617696000178
  - `requestDeliveryTime` string  — 已废弃！！ e.g. `2022-03-17 06:05:16.000-0300`
  - `performanceType` string  — 订单履约方式；1: 订单由SHEIN整合物流渠道履行/ 2: 订单由非SHEIN整合物流渠道履行，卖家直接将订单履行给买家；（已废弃，请使用新字段optionalLogisticsList）

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/order/order-detail' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570849017' \
--data-raw '{
  "orderNoList": [
    "GSONPE05Y0004Q7"
  ]
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": [
        {
            "orderNo": "GSO1CL53800M5D4",
            "orderType": 1,
            "orderPlaceType": 2,
            "optionalLogisticsList": [
                1,
                2
            ],
            "orderLogisticsType": 0,
            "receiveMsg": {
                "country": "United States",
                "province": "puerto rico",
                "city": "Jeddah",
                "postCode": "39900-000"
            },
            "performanceType": 2,
            "orderStatus": 1,
            "isCod": 2,
            "isOverLimitOrder": 2,
            "unpackingStatus": null,
            "orderTag": 0,
            "deliveryType": 1,
            "printOrderStatus": 1,
            "invoiceStatus": 4,
            "orderGoodsInfoList": [
                {
                    "goodsId": 5230236437987443003,
                    "skuCode": "I73dnsqbbier",
                    "skc": "sa25060976623960851",
                    "goodsSn": "dangao wen 01",
                    "sellerSku": "12312312312333",
                    "goodsStatus": 1,
                    "newGoodsStatus": 1,
                    "skuAttribute": [
                        {
                            "attrValueId": "2147488295",
                            "attrName": "藏蓝色",
                            "language": "CN"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "US"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "PT"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "TH"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "ES"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "IT"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "PL"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "TR"
                        }
                    ],
                    "goodsTitle": "GoodsName111111111111",
                    "spuPicURL": "http://imgdeal-test01.shein.com/pi_img/2021/11/03/16359230894287290938_thumbnail_220x293.jpg",
                    "goodsWeight": 500.0,
                    "storageTag": 1,
                    "performanceTag": 2,
                    "goodsExchangeTag": 1,
                    "unpackingGroupNo": "",
                    "unpackingGroupInvoiceStatus": null,
                    "beExchangeEntityId": 0,
                    "orderCurrency": "USD",
                    "saleCurrency": null,
                    "sellerCurrencyPrice": 12.98,
                    "costPrice": null,
                    "orderCurrencyStoreCouponPrice": 0.0,
                    "orderCurrencyPromotionPrice": 0.0,
                    "settleCurrencyPromotionPrice": null,
                    "commission": 0.0,
                    "commissionRate": 0.0,
                    "serviceCharge": null,
                    "performanceServiceCharge": 0.0,
                    "estimatedIncome": 12.98,
                    "spuName": "a250609766239",
                    "saleTax": 0.37,
                    "sellerRealTax": 0.0,
                    "commissionSaleTax": null,
                    "warehouseCode": "PS2251996304",
                    "warehouseName": "U.S.",
                    "sellerCurrencyDiscountPrice": 17.33,
                    "mxTaxPrice": 0.0,
                    "timeOutList": [
                        {
                            "timeOutType": 1,
                            "timeOutTime": "2025-07-25T19:22:31.000+0800"
                        },
                        {
                            "timeOutType": 100,
                            "timeOutTime": "2025-07-28T06:22:31.000+0800"
                        }
                    ],
                    "customizationFlag": 1,
                    "customizationInfo": {},
                    "freightSource": 0
                },
                {
                    "goodsId": 5230236437987443004,
                    "skuCode": "I73dnsqbbier",
                    "skc": "sa25060976623960851",
                    "goodsSn": "dangao wen 01",
                    "sellerSku": "12312312312333",
                    "goodsStatus": 1,
                    "newGoodsStatus": 1,
                    "skuAttribute": [
                        {
                            "attrValueId": "2147488295",
                            "attrName": "藏蓝色",
                            "language": "CN"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "US"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "PT"
                        },
                        {
                            "attrValueId": "2147488295",
                            "attrName": "Navy",
                            "language": "TH
```

## POST `/open-api/goods/query-sku-sales` — 根据SKU查询销量
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001305 · modes: 全托管, SHEIN自营, 半托管, POP · QPS:  · updated 2025-07-21 11:33:00

商家可以通过该接口查询7天和30天销量; 平台限制的QPS为 40/S，某一时间点大批量的调用接口可能会导致限流; 接口的数据为每天北京时间0点统计更新，建议开发者在北京时间的凌晨2点到7点均匀的拉取数据

**Request body**

- `skuCodeList` string[] **req** — skuCode，最多上传100个skuCode

**Response body**

- `bbl` object  — 响应异常时的bbl相关信息
  - `info` object  — 
    - `*` object[]  — 
  - `npid` string  — 
- `code` string **req** — 响应编码 成功：0
- `info` object  — 
  - `dataList` object[] **req** — sku销量集合
    - `c30dSaleCnt` integer **req** — 30日销量
    - `c7dSaleCnt` integer **req** — 7日销量
    - `cydSaleCnt` integer **req** — 昨日销量
    - `dt` string **req** — 数据统计的截止时间，7天和30天销量根据该时间为起始天数进行7天和30天的销量统计；yyyyMMdd
    - `skuCode` string **req** — sku编码
    - `realTimeSaleCnt` integer **req** — 当日销量
- `msg` string  — 错误描述,成功：OK
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/goods/query-sku-sales' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570849017' \
--data-raw '{
"skuCodeList":["I6il0w9szgmx"]
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "dataList": [
            {
                "skuCode": "I46u675r42l4",
                "realTimeSaleCnt": 0,
                "c7dSaleCnt": 0,
                "c30dSaleCnt": 0,
                "dt": ""
            }
        ]
    },
    "bbl": null,
    "traceId": "fe801921785899e"
}
```

## POST `/open-api/order/confirm-no-stock` — 确认无货接口
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001415 · modes: 自运营, 半托管 · QPS: 40 · updated 2025-10-11 21:41:39

该API支持商家取消订单中的商品。调用该接口后，开发者再次调用订单详情接口时，可以发现商品的storageTag字段会从1变更为3。随后，系统会在一段时间后将商品的订单状态字段newGoodsStatus修改为6（退款）。; ⚠️ 注意：商家频繁进行订单取消操作可能会导致店铺受到处罚，请务必谨慎操作

**Request body**

- `skuCode` string  — SHEIN平台生成的 skuCode；skuCode 和 orderGoodsId 不允许同时为空 e.g. `siqwersk74ujdjd`
- `orderNo` string **req** — 订单号 e.g. `GSONTJ4490004CY`
- `orderGoodsId` integer **req** — 商品唯一标识；同种商品多件，每件goodsId不同，通过订单详情接口获得 e.g. `1212121`

**Response body**

- `code` string **req** — 响应码 e.g. `99002`
- `info` object  — 响应信息
- `msg` string  — 错误描述信息 e.g. `The request parameter is abnormal, please refresh and try again`
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/order/confirm-no-stock' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570817402' \
--data-raw '{
	"orderNo":"GSON8F44T00000N",
	"orderGoodsId":3000000000065821,
        "skuCode": "I95xuum0vjv5"
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {}
}
```

## POST `/open-api/return-order/list` — 退货单-查询退货单列表
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001281 · modes: 自运营, 半托管 · QPS: 100 · updated 2025-07-21 11:30:38

通过该接口获取退货单列表；如何对接退货单请查看客单退货退款服务； (https://open.sheincorp.com/documents/system/949a61a4-bb8b-4683-922a-8755e079b394)

**Request body**

- `queryType` integer **req** — 时间查询的维度类型：1：退货单下发给到商家的时间/ 2：买家申请退货时间/ 3：退货单更新时间 e.g. `1`
- `startTime` string **req** — yyyy-MM-dd HH:mm:ss 默认查询48小时以内数据 e.g. `2023-08-03 13:50:40`
- `endTime` string **req** — yyyy-MM-dd HH:mm:ss 默认查询48小时以内数据 e.g. `2023-08-03 13:51:40`
- `page` integer **req** — 请求页码 e.g. `1`
- `pageSize` integer **req** — limit【1，30】 e.g. `30`
- `returnOrderStatus` integer  — 1：已关闭/ 2：已申请/ 3：已取消/ 5：已收货/ 6：已妥投/ 7：待交接/ 8：待SHEIN仓中转/ 9：已完成 e.g. `1`

**Response body**

- `code` string  — 成功：0 e.g. `0`
- `msg` string  — 成功：OK e.g. `OK`
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪
- `info` object **req** — 
  - `count` integer  — 总条数 e.g. `1`
  - `returnOrderList` object[] **req** — 退货单列表
    - `returnOrderNo` string  — 退货单号 e.g. `N8BFM00MMY`
    - `returnOrderStatus` integer  — 退货单状态 e.g. `5`
    - `addTime` string  — 退货单下发时间，yyyy-MM-dd HH:mm:ss e.g. `2023-07-27 23:49:27`
    - `requestReturnTime` string  — 退货单申请时间，yyyy-MM-dd HH:mm:ss e.g. `2023-07-27 23:49:26`
    - `updateTime` string  — 退货单更新时间，yyyy-MM-dd HH:mm:ss

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/return-order/list' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570817402' \
--data-raw '{
    "queryType": 1,
    "startTime": "2024-05-23 00:00:00",
    "endTime": "2024-05-24 23:59:40",
    "page": 1,
    "pageSize": 10,
    "returnOrderStatus": 5
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "count": 1,
        "returnOrderList": [
            {
                "returnOrderNo": "NGGQM0NLE1",
                "returnOrderStatus": 5,
                "addTime": "2024-05-23 10:49:36",
                "requestReturnTime": "2024-05-23 10:49:23",
                "updateTime": "2024-05-23 10:49:37"
            }
        ]
    },
    "bbl": {}
}
```

## POST `/open-api/return-order/details` — 退货单-退货单详情查询
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001282 · modes: 自运营, 半托管 · QPS: 40 · updated 2025-07-21 11:30:42

通过该接口获取退货单详情；如何对接退货单请查看客单退货退款服务； (https://open.sheincorp.com/documents/system/949a61a4-bb8b-4683-922a-8755e079b394)

**Request body**

- `returnOrderNoList` string[] **req** — 最多30条

**Response body**

- `code` string  — 响应码，成功给0 e.g. `0`
- `msg` string  — 错误信息 无错误时给“OK” e.g. `OK`
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪
- `info` object[] **req** — 响应数据
  - `returnOrderNo` string  — 退货单号 e.g. `N8VTE00002`
  - `returnOrderStatus` integer  — 1已关闭 2已申请 3已取消 5已收货 6已妥投 7待交接 8待SHEIN仓中转 9已完成 e.g. `5`
  - `noReturnGoodsSign` integer  — 0：退货 1：不退货 e.g. `0`
  - `returnOrderTagCode` integer  — 1:KOL退货单;2:丢件
  - `orderNo` string  — 关联客单单号 e.g. `GSON8X44S0000MP`
  - `site` string  — 销售站点 e.g. `shein-br`
  - `shippingCode` string  — 寄件码
  - `platformExpressNo` string  — SHEIN 平台运单号
  - `memberExpressNo` string  — 买家上传运单号
  - `expressCompanyName` string  — 退货物流商名称
  - `refundOrderNos` string[] **req** — 平台退回给卖家的退货单号
  - `refundWaybill` json  — 平台退回给卖家的退货运单号
  - `refundExpressCompanyName` string  — 平台退回给卖家的退货物流商名称
  - `performanceCost` integer  — 退货履约服务费 e.g. `0`
  - `invoiceStatus` integer  — 巴西退货发票状态；0:不开票/ 1:待开票/ 2:已申请发票/ 3:开票成功 e.g. `1`
  - `requestReturnTime` string  — 退货申请时间,格式： yyyy-MM-dd HH:mm:ss e.g. `2023-08-03 11:17:26`
  - `allocateTime` string  — 退货单下发时间，格式：yyyy-MM-dd HH:mm:ss e.g. `2023-08-03 11:17:28`
  - `lastUpdateTime` string  — 更新时间，格式：yyyy-MM-dd HH:mm:ss e.g. `2023-08-03 16:13:39`
  - `sellerSignedTime` string  — 退货签收时间，格式：yyyy-MM-dd HH:mm:ss e.g. `2023-08-03 16:13:32`
  - `cancelTime` string  — 取消退货申请时间，格式：yyyy-MM-dd HH:mm:ss
  - `completedTime` string  — 退货完成时间，格式：yyyy-MM-dd HH:mm:ss
  - `checkStatus` integer  — 对账状态，1:已对账/ 2: 未对账 e.g. `1`
  - `stockMode` integer  — 1-SHEIN自主备货, 2-备货到SHEIN仓, 3-不备货到SHEIN仓 e.g. `3`
  - `receiveType` integer  — 0默认;1卖家收货;2仓库收货
  - `returnGoodsInfoList` object[] **req** — 
    - `goodsId` bigint  — 关联订单的goodsId； e.g. `4275374634592257`
    - `sku` string  — SHEIN sku ID e.g. `I52pve7u3wf3`
    - `skc` string  — SHEIN skc ID e.g. `sM23011604853289`
    - `goodsSn` string  — seller spu SN e.g. `222222222`
    - `skuSn` string  — seller sku SN
    - `commodityAttributeList` object[] **req** — 商品销售属性集
      - `attrValueId` string  — 属性值ID e.g. `140,964`
      - `attrName` string  — 属性值名称集合 e.g. `棕色-5`
      - `language` string  — 语种 e.g. `CN`
    - `goodsTitle` string  — SPU商品名称 e.g. `test15`
    - `imageUrl` string  — SPU主图链接 e.g. `//imgdeal-test01.shein.com/gspCenter/goodsImage/2023/1/16/7338081779_4399/1732C5C9E09799C3CB328E6DDC568A30_thumbnail_220x293.jpg`
    - `goodsStatus` integer  — 商品退货状态；1已关闭 2已申请 3已取消 5已收货 6已妥投 7待交接 8待SHEIN仓中转 9已完成 e.g. `5`
    - `returnImageList` object[] **req** — 退货视频图片
      - `type` integer  — 1-图片，2-视频 e.g. `1`
      - `link` string  — url e.g. `http://filetest.ltwebstatic.com/cspfile/test/return/1691032590167.jpg`
    - `currency` string  — 币种
    - `saleCurrency` string  — 销售币种
    - `sellerCurrencyPrice` decimal  — 商品价格 e.g. `666`
    - `costPrice` decimal  — 供货价
    - `settleCurrencyPromotionPrice` decimal  — 活动提报优惠金额
    - `sellerCurrencyStoreCouponPrice` decimal  — 店铺优惠金额 e.g. `0`
    - `sellerCurrencyPromotionPrice` decimal  — 活动优惠金额 e.g. `0`
    - `estimateCommission` decimal  — 佣金金额 e.g. `0`
    - `commissionSaleTax` decimal  — 佣金消费税
    - `performancePrice` decimal  — 退货履约服务费
    - `returnExpense` decimal  — 退货处理费
    - `sellerRealTax` decimal  — 欧洲vat税费 e.g. `0`
    - `estimateIncomeMoney` decimal  — 1、自主运营模式：预计支出=商品价格-优惠券金额-活动优惠金额-佣金+退货处理费+退货单履约服务费。; 2、半托管模式：预计支出=商品供货价 - 店铺优惠券金额 - 活动提报优惠金额+ 欧洲VAT税费（补贴）+退货处理费+退货单履约服务费 e.g. `666`
    - `estimateTaxIncomeMoney` decimal  — 1、自主运营模式：预计支出=商品价格-优惠券金额-活动优惠金额-佣金- 欧洲VAT税费（代扣代缴）-佣金消费税+退货处理费+退货单履约服务费。; 2、半托管模式：预计支出=商品供货价 -活动提报优惠金额+ 欧洲VAT税费（补贴）+退货处理费+退货单履约服务费 e.g. `666`
    - `returnReasonList` object[] **req** — 退货原因
      - `language` string  — 语种 e.g. `CN`
      - `reason` string  — 原因 e.g. `配饰/件漏发zh-tw`

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/return-order/details' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570817402' \
--data-raw '{
  "returnOrderNoList": [
    "NPVYE07KE2"
  ]
}'
```

**Response example**
```
{
  "code": "0",
  "msg": "OK",
  "info": [
    {
      "returnOrderNo": "NPVYE07KE2",
      "returnOrderStatus": 6,
      "noReturnGoodsSign": 0,
      "returnOrderTagCode": null,
      "orderNo": "GSONPS56A004WJ8",
      "site": "shein-es",
      "shippingCode": "",
      "platformExpressNo": "PQ7LEW0400154360117460Q",
      "memberExpressNo": "",
      "expressCompanyName": "Return with Post Office label",
      "refundOrderNos": [],
      "refundWaybill": "",
      "refundExpressCompanyName": "",
      "performanceCost": 0,
      "invoiceStatus": 1,
      "requestReturnTime": "2024-12-10 15:42:01",
      "allocateTime": "2024-12-10 15:42:03",
      "lastUpdateTime": "2024-12-12 21:52:29",
      "sellerSignedTime": "",
      "cancelTime": "",
      "completedTime": "",
      "checkStatus": 2,
      "stockMode": 3,
      "receiveType": 0,
      "returnGoodsInfoList": [
        {
          "goodsId": 837115739,
          "sku": "I43cll4jk2za",
          "skc": "sl2410020038321928",
          "goodsSn": "4008789710079",
          "currency": "EUR",
          "saleCurrency": null,
          "skuSn": "17009016",
          "commodityAttributeList": [
            {
              "attrValueId": "447,474",
              "attrName": "多色-均码",
              "language": "CN"
            },
            {
              "attrValueId": "447,474",
              "attrName": "Multicolor-one-size",
              "language": "US"
            },
            {
              "attrValueId": "447,474",
              "attrName": "Multicolorido-Tamanho Único",
              "language": "PT"
            },
            {
              "attrValueId": "447,474",
              "attrName": "มัลติคัลเลอร์-ไซส์เดียว",
              "language": "TH"
            },
            {
              "attrValueId": "447,474",
              "attrName": "Multicolor-Unitalla",
              "language": "ES"
            },
            {
              "attrValueId": "447,474",
              "attrName": "Multicolore-Tagli Unica",
              "language": "IT"
            }
          ],
          "goodsTitle": "Playmobil Centro De Cuidados De Animales - Entrega en 24/48h (Península)",
          "imageUrl": "https://img.ltwebstatic.com/images3_spmp/2024/10/02/cc/17278484841dfa54bb4f8f1f062973439b4bf39737_square_thumbnail_220x293.jpg",
          "goodsStatus": 6,
          "returnImageList": [
            {
              "type": 1,
              "link": ""
            }
          ],
          "sellerCurrencyPrice": 115.99,
          "costPrice": null,
          "sellerCurrencyStoreCouponPrice": 0,
          "sellerCurrencyPromotionPrice": 0,
          "settleCurrencyPromotionPrice": null,
          "estimateCommission": 9.28,
          "commissionSaleTax": 0,
          "performancePrice": 0,
          "returnExpense": 0,
          "sellerRealTax": 0,
          "estimateIncomeMoney": 106.71,
          "estimateTaxIncomeMoney": 106.71,
          "returnReasonList": [
            {
              "language": "CN",
              "reason": "我不喜歡，不想要了。"
            },
            {
              "language": "EN",
              "reason": "Don't like so I don't want it"
            },
            {
              "language": "PT",
              "reason": "Eu não gosto disso, e não quero isso."
            },
            {
              "language": "TH",
              "reason": "ฉันไม่ชอบมัน ฉันไม่ต้องการมันแล้ว"
            },
            {
              "language": "ES",
              "reason": "No me gusta, no lo quiero."
            }
          ]
        }
      ]
    }
  ],
  "bbl": {},
  "traceId": "87cd406a2d5d4961"
}
```

## POST `/open-api/gsp/warehouse-address` — 查询仓库地址
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001786 · modes: 自运营, 半托管 · QPS: 80 · updated 2026-06-09 10:05:40

通过接口获取仓库地址信息用于在线下单业务；

**Response body**

- `code` string  — 成功：0 e.g. `0`
- `msg` string  — 错误描述,成功：OK e.g. `OK`
- `info` object  — 
  - `openApiAddressInfos` object[]  — 仓库地址列表
    - `warehouseAddressCode` string  — 仓库地址编码 e.g. `WH2505093344009216`
    - `warehouseName` string  — 仓库名称 e.g. `美国发货仓`
    - `salesSite` string[]  — 销售站点 e.g. `shein-us`
    - `addressInfo` object  — 仓库地址信息
      - `country` string  — 国家 e.g. `United States`
      - `province` string  — 省份 e.g. `CALIFORNIA`
      - `city` string  — 城市 e.g. `Avenal`
      - `district` string  — 区域
      - `postCode` string  — 邮编 e.g. `94501`
      - `address1` string  — 地址1 e.g. `test address`
      - `address2` string  — 地址2
      - `phone` string  — 联系电话 e.g. `2313343434`
- `traceId` string  —  e.g. `5180cdc2c1911c29`

**Request example**
```
curl --location --request POST 'https://openapi.sheincorp.com/open-api/gsp/warehouse-address' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'x-lt-timestamp: 1753756515388' \
--header 'Content-Type: application/json;charset=UTF-8' \
--data-raw '{
}'
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "openApiAddressInfos": [
            {
                "warehouseAddressCode": "WH2505093344009216",
                "warehouseName": "美国发货仓",
                "salesSite": [
                    "shein-us"
                ],
                "addressInfo": {
                    "country": "United States",
                    "state": "CALIFORNIA",
                    "city": "Avenal",
                    "district": "",
                    "postCode": "94501",
                    "address1": "test address",
                    "address2": "",
                    "phone": "2313343434"
                }
            }
        ]
    },
    "bbl": {},
    "traceId": "5180cdc2c1911c29"
}
```

## POST `/open-api/gsp/available-shipping-warehouse` — 查询订单可用发货仓库
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001815 · modes: 自运营, 半托管 · QPS: 50 · updated 2026-06-15 10:34:00

提供接口查在线下单业务的订单维度数据的可用发货仓库；; 请查阅仓库常见不可用原因以及解决方案 (https://open.sheincorp.com/documents/faq-detail/291)了解更全面的信息

**Request body**

- `orderNo` string **req** — 订单号

**Response body**

- `code` string **req** — 响应编码 成功：0
- `msg` string  — 错误描述,成功：OK
- `traceId` string **req** — 请求的唯一标识；用于异常报错跟踪
- `info` object **req** — 
  - `availableWarehouses` object[] **req** — 订单可用发货仓列表
    - `availableStatus` integer **req** — 发货仓可用状态：1-可用、0-暂不可用
    - `unavailableReason` string  — 暂不可用原因
    - `unavailableReasonCode` string  — 暂不可用原因编码
    - `warehouseAddressCode` string **req** — 仓库地址编码
    - `warehouseName` string **req** — 仓库名称
  - `orderNo` string **req** — 订单号

## GET `/open-api/order/purchase-order-infos` — 订单接口-获取采购单信息
Doc: https://open.sheincorp.com/documents/apidoc/detail/3002055 · modes: 自运营, 全托管, SHEIN自营, 半托管, POP · QPS: 50 · updated 2026-10-16 15:12:39

该接口适用于全托管、SHEIN自营以及POP三种店铺类型，可用来获取对应店铺的采购单列表，并进一步查询每个采购单的详细信息。通过该接口，可以查询到普通备货单和急采单两类采购单。

**Query string**

- `orderNos` string  — 采购单号，支持批量以','间隔，一次最多请求200采购单号
- `skcs` string  — skc列表
- `type` integer  — 采购单类型；1：急采/ 2：备货
- `supplierCodes` string  — 商家货号数组
- `combineTimeStart` string  — 备货单或急采单下发时间--开始; Date格式 2018-05-23 10:29:59； 查询不能超过60天
- `combineTimeEnd` string  — 备货单或急采单下发时间--结束; Date格式 2018-05-23 10:29:59； 查询不能超过60天
- `pageNumber` integer  — 页码
- `pageSize` integer  — 一页大小，最大200条
- `updateTimeStart` string  — 备货单或急采单更新时间--开始; Date格式 2018-05-23 10:29:59； 查询不能超过60天
- `updateTimeEnd` string  — 备货单或急采单更新时间--结束; Date格式 2018-05-23 10:29:59； 查询不能超过60天
- `selectJitMother` integer  — Jit母单查询标识；1：返回所有采购单（含Jit母单）/ 2或不传：返回除Jit母单外的其他采购单（不含Jit母单）

**Response body**

- `code` string  — 状态码
- `msg` string  — 错误描述,成功：OK；支持指定语种出参；
- `info` object  — 响应信息
  - `count` double  — 总数
  - `pageNo` double  — 页码
  - `pageSize` double  — 页面数量
  - `list` object[]  — 数据列表
    - `orderNo` string  — 订单编号
    - `typeName` string  — 订单类型，1：急采，2：备货
    - `type` int64  — 备货单类型，1：急采，2：备货
    - `status` integer  — 订单状态；1:待下单/ 2:已下单/ 3:发货中/ 4:已送货/ 5:已收货/ 6:已查验/ 7:已退货/ 8:已完成/ 9:无货下架/ 10:已作废/ 11:待审核/ 12:分单中/ 13:待退货; 全托管（代运营）模式只有2、3、4、5、7、8、10状态；
    - `sceneType` integer  — 生成场景，1:履约需求 2:拆分履约 3:补充入仓；sceneType=3的时候不需要发货，不需要创建发货单。jit母单场景该字段为null，仅全托管场景可用。
    - `orderExtends` object[]  — 详情信息
      - `skc` string  — SHEIN skc
      - `skuCode` string  — SHEIN sku
      - `supplierCode` string  — 商家货号（skc纬度）
      - `supplierSku` string  — 商家sku
      - `price` double  — 结算价格
      - `suffixZh` string  — 属性集是属性值的拼接，如Blue-L，最多三个属性值拼接
      - `imgPath` string  — SKC图片
      - `skuImg` string  — sku图片；该字段仅全托管可用；
      - `needQuantity` integer  — 需求数量
      - `orderQuantity` integer  — 下单数量
      - `deliveryQuantity` integer  — 送货数量
      - `receiptQuantity` integer  — 收货数量
      - `storageQuantity` integer  — 入仓数量
      - `defectiveQuantity` integer  — 次品数量
      - `requestDeliveryQuantity` string  — JIT母单中已下子备货单数量（适用Jit场景）；
      - `noRequestDeliveryQuantity` string  — JIT母单中未下子备货单数量（适用Jit场景）；
      - `alreadyDeliveryQuantity` string  — JIT母单中子备货单的总已发货单数量（适用Jit场景）；
      - `remark` string  — 备注
    - `currencyName` string  — 币种名称；全托管（代运营）模式支持指定语种出参；
    - `currency` string  — 币种代码
    - `currencyId` integer  — 币种Id
    - `isPriorProductionName` string  — 是否优先生产（枚举值：是、否；适用Jit场景）；
    - `isJitMotherName` string  — 是否JIT母单（枚举值：是、否）; 场景示例：JIT母单是预下单，需要发货时，比如需要发货100，会产生一个JIT子单（即普通订单）数量100。
    - `supplierName` string  — 商家名称
    - `orderSupervisor` string  — 跟单员（适用Jit场景）；
    - `addUid` string  — 添加人（适用Jit场景）；
    - `orderLabelInfo` object[]  — 备货单标签信息（暂只支持全托管模式返回）
      - `orderLabel` integer  — 备货单标签枚举值；
      - `orderLabelName` string  — 备货单标签名称；如“安检”等信息；支持按指定语种出参；
    - `goodsLevel` object[]  — 备货单商品层次信息（暂只支持全托管模式返回）
      - `goodsLevel` integer  — 商品层次名称枚举值；
      - `goodsLevelName` string  — 商品层次名称；如“备货款A”，“新款A”等信息；支持按指定语种出参；
    - `requestDeliveryTime` datetime  — 要求发货时间（适用Jit场景）；
    - `requestReceiptTime` datetime **req** — 要求收货时间，采购单下发后有值（备货&急采） 要求送至SHEIN仓的最晚时间
    - `requestTakeParcelTime` string  — 要求取件时间，急采单下发后有值，备货单可能返回为空；送货方式选择“SHEIN合作物流”，商家超过该时效会交货给到物流，将会面临罚款
    - `addTime` string  — 备货单的创建时间
    - `allocateTime` string  — 备货单的下发时间
    - `updateTime` datetime  — 更新时间；状态发生变更的采购单的时间
    - `reserveTime` string  — 预约送货时间；全托管（代运营）模式无需关注
    - `receiptTime` string  — SHEIN仓库收货时间
    - `checkTime` string  — 质检完成时间
    - `storageTime` string  — 仓库确认入库的时间
    - `returnTime` string  — 退货时间；质检失败，订单状态变为「已退货」，代表SHEIN确认要进行退货
    - `requestCompleteTime` string  — 要求完工时间（适用Jit场景）；
    - `deliveryTime` datetime  — 发货时间
    - `firstMarkName` string  — 首单标识；首单要求发货80%以上，自主上新的订单首单要求订单所有尺码的送货数量>=1
    - `firstMark` boolean  — 首单标识
    - `prepareTypeName` string  — 备货类型名称 ，当采购单类型是备货时有值；备货类型一致才可以合单发货；当值=[JIT备货]时，代表该采购单为Jit采购单；
    - `prepareTypeId` integer  — 备货类型值 ，当采购单类型是备货时有值；备货类型一致才可以合单发货；当值=[9]时代表该备货单为Jit子单；
    - `categoryName` string  — 订单类型名称 (ODM单 线上单 线下单)；全托管（代运营）模式无需关注
    - `orderMarkName` string  — 订单标识名称 (正常备货 样衣订单 退货再入仓)；全托管（代运营）模式无需关注
    - `urgentTypeName` string  — 紧急类型 (普通 紧急 特急)；表示订单的紧急程度
    - `urgentType` integer  — 紧急标识；仅全托管（代运营）模式返回；
    - `storageId` string  — SHEIN收货仓库id
    - `recommendedSubWarehouseId` string  — 预估收货仓id；只有一个枚举ID=1347（华东质检仓）或者0（华东转运仓）或者空，预估收货仓ID一致时才能合单发货；
    - `warehouseName` string  — 收货仓库id对应的仓库名称
    - `countryMarket` int64  — 预销国家市场；0：默认/ 1：南大区/ 2：北大区；当备货单类型type=2时才会返回，1和2的备货单不能合单发货，0可以和1或2合单发货；如果countryMarket返回null则表示没有指定的大区。
    - `isProductionCompletionName` string  — 是否生产完成（适用Jit场景）；
    - `isAllDeliveryName` string  — 是否完全要求发货（适用Jit场景）；
    - `isDeliveryName` string  — 是否送货（适用Jit场景）；
    - `statusName` string  — 状态名称；全托管（代运营）模式支持指定语种出参；
    - `customInfoId` string  — 仅限订单为C端定制有数据，客单定制信息id
    - `customInfo` json  — 仅限订单为C端定制有数据，客单定制信息
    - `attributeVersion` integer  — 成份版本号；（当前仅OEM，ODM商家有返回值）
    - `isIncrementOnWay` integer  — 是否增值中；1:是/ 2:否；（当前仅OEM，ODM商家有返回值）
    - `deliveryCheckRuleFields` object  — 全托管发货规则字段集
      - `ruleName` string  — 发货规则名称，如“订单大仓”、“订单类型”
      - `fieldValue` object  — 发货规则对应的字段值，针对不同的发货规则名称，返回的规则枚举值不同
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request GET 'https://openapi.sheincorp.cn/open-api/order/purchase-order-infos?orderNos=PB2505200000635' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570729613' \
--header 'language: EN' \
--data-raw ''
```

**Response example**
```
{
    "code": "0", 
    "msg": "OK", 
    "info": {
        "count": 1, 
        "pageNo": 1, 
        "pageSize": 20, 
        "list": [
            {
                "orderNo": "PB2505200000635", 
                "typeName": "急采", 
                "currencyName": "人民币元", 
                "currency": null, 
                "supplierName": "H12", 
                "orderSupervisor": "练红秀", 
                "addUid": "dms-root", 
                "requestDeliveryTime": "2025-04-23 23:59:59", 
                "orderLabelInfo": [
                    {
                        "orderLabel": 163, 
                        "orderLabelName": ""
                    }, 
                    {
                        "orderLabel": 13, 
                        "orderLabelName": "安检"
                    }, 
                    {
                        "orderLabel": 193, 
                        "orderLabelName": "履约评估考核订单"
                    }
                ], 
                "goodsLevel": [
                    {
                        "goodsLevel": 228, 
                        "goodsLevelName": "退供款"
                    }
                ], 
                "addTime": "2025-04-23 06:17:38", 
                "allocateTime": "2025-04-23 06:21:05", 
                "reserveTime": "1970-01-01 08:00:01", 
                "receiptTime": "1970-01-01 08:00:01", 
                "checkTime": "1970-01-01 08:00:01", 
                "storageTime": "2025-04-24 21:44:48", 
                "returnTime": "1970-01-01 08:00:01", 
                "requestTakeParcelTime": "2025-04-23 23:59:59", 
                "requestReceiptTime": null, 
                "firstMarkName": "否", 
                "prepareTypeName": "备货单", 
                "categoryName": "1急采", 
                "orderMarkName": "正常备货", 
                "warehouseName": "佛山仓", 
                "urgentTypeName": "", 
                "urgentType": null, 
                "storageId": 1, 
                "recommendedSubWarehouseId": 0, 
                "requestCompleteTime": null, 
                "isProductionCompletionName": null, 
                "isAllDeliveryName": null, 
                "isDeliveryName": null, 
                "currencyId": 156, 
                "firstMark": 2, 
                "orderMarkId": 733, 
                "prepareTypeId": 17, 
                "category": 0, 
                "type": 1, 
                "status": 8, 
                "statusName": "已完成", 
                "updateTime": "2025-04-25 01:21:59", 
                "isJitMotherName": "否", 
                "isPriorProductionName": null, 
                "orderExtends": [
                    {
                        "skc": "s255904", 
                        "price": 73, 
                        "needQuantity": null, 
                        "orderQuantity": 1, 
                        "deliveryQuantity": 1, 
                        "receiptQuantity": 0, 
                        "storageQuantity": 1, 
                        "defectiveQuantity": 0, 
                        "supplierCode": "SWLC1265-5BR28", 
                        "remark": "", 
                        "imgPath": "https://img.ltwebstatic.com/images3_spmp/2025/03/14/e2/1741946708842dfe053372c941778f161b55e09e60.jpg", 
                        "skuImg": "", 
                        "requestDeliveryQuantity": null, 
                        "noRequestDeliveryQuantity": null, 
                        "alreadyDeliveryQuantity": null, 
                        "supplierSku": "SBR28", 
                        "skuCode": "I2840edmz", 
                        "suffixZh": "棕色-28 inch"
                    }
                ], 
                "deliveryTime": "2025-04-23 17:13:16", 
                "customInfoId": "", 
                "customInfo": null
            }
        ]
    }, 
    "bbl": { }, 
    "traceId": "b30354e8da18ea2e"
}
```

## GET `/open-api/shipping/basic` — 发货基本信息查询接口
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001981 · modes: 自运营, 全托管, SHEIN自营, 半托管, POP · QPS: 50 · updated 2026-08-21 19:58:22

通过该接口获取商家发货地址、发货仓、支持的发货方式、打包方式、发货车队、发货路径等发货的信息。; 查询SHEIN合作物流信息需要调用 查询SHEIN合作物流产品 (https://open.sheincorp.com/documents/apidoc/detail/3001954)

**Query string**

- `orderType` integer **req** — 订单类型，1：急采，2：备货
- `addressId` integer  — 不同的发货地址可匹配不同的快递物流，不选择发货地址某些物流公司无法匹配
- `orderNoList` string  — 订单号list
- `includeSharedAddr` integer  — 是否查询共享发货地址，1：是，2：否，默认为1

**Response body**

- `code` string **req** — 响应编码 成功：0
- `info` object  — 
  - `addressList` object[]  — 发货地址
    - `addressId` integer  — 地址ID
    - `addressName` string  — 地址名称
    - `isSharedAddress` integer  — 是否为共享发货地址
  - `deliveryTypeList` object[]  — 发货方式
    - `deliveryTypeName` string  — 发货方式名称，仅做参考
    - `deliveryTypeValue` integer  — 发货方式的值
  - `expressCompanyList` object[]  — 获取商家自行联系的物流服务商信息，SHEIN合作的物流服务商信息请通过查询SHEIN合作物流产品 (https://open.sheincorp.com/documents/apidoc/detail/3001973)接口获取
    - `companyCode` string  — 快递编码
    - `companyName` string  — 快递公司名称
    - `isSupport` boolean  — 服务商类型，true：SHEIN集成物流服务商，false：商家自行委托第三方物流服务商
    - `isRecommend` string  — 是否推荐物流，1：是，2：否
  - `motorcadeList` object[]  — 车队列表；自行委托第三方（使用车队）的发货场景下需要使用，其它的发货方式不需要使用车队。如果车队列表返回为空，则表示目前不支持使用车队发货。
    - `isSupport` boolean  — 服务商类型；true:SHEIN集成车队；false：商家自行委托第三方车队；
    - `motorcadeId` string  — 车队编码
    - `motorcadeName` string  — 车队名称
  - `packageType` integer  — 打包类型，1：包裹，2：箱唛
  - `shippingRouteList` string  — 发货路径，0：直送路径，无需装箱明细。1：直送路径，需要装箱明细。2：集货路径
  - `supplierWarehouseList` object[]  — 商家仓库
    - `supplierWarehouseId` int64  — 商家仓库id
    - `warehouseName` string  — 仓库名称
- `msg` string  — 错误描述,成功：OK
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request GET 'https://openapi.sheincorp.cn/open-api/shipping/basic?orderType=1' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570464986' \
--data-raw ''
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "deliveryTypeList": [
            {
                "deliveryTypeName": "快递/物流送货",
                "deliveryTypeValue": 1
            },
            {
                "deliveryTypeName": "送货上门",
                "deliveryTypeValue": 2
            },
            {
                "deliveryTypeName": "定点收货",
                "deliveryTypeValue": 3
            },
            {
                "deliveryTypeName": "新增发货方式",
                "deliveryTypeValue": 4
            },
            {
                "deliveryTypeName": "上门查货",
                "deliveryTypeValue": 21
            },
            {
                "deliveryTypeName": "送货上门",
                "deliveryTypeValue": 10
            }
        ],
        "addressList": [
            {
                "addressName": "河南地址",
                "addressId": 4722
            },
            {
                "addressName": "青羊地址",
                "addressId": 4721
            },
            {
                "addressName": "宝鸡",
                "addressId": 4720
            }
        ],
        "supplierWarehouseList": [
            {
                "warehouseName": "323432",
                "supplierWarehouseId": 78377
            },
            {
                "warehouseName": "仓库kkiki",
                "supplierWarehouseId": 78376
            },
            {
                "warehouseName": "总仓",
                "supplierWarehouseId": 78359
            }
        ],
        "expressCompanyList": [
            {
                "companyName": "提前我认为其他完全放弃",
                "companyCode": "afasfsag",
                "isSupport": true
            },
            {
                "companyName": "车门",
                "companyCode": "chemen",
                "isSupport": true
            },
            {
                "companyName": "dhl",
                "companyCode": "dhl",
                "isSupport": false
            },
            {
                "companyName": "fedex",
                "companyCode
```

## GET `/open-api/shipping/warehouse` — 收货仓信息查询
Doc: https://open.sheincorp.com/documents/apidoc/detail/3001982 · modes: 自运营, 全托管, SHEIN自营, 半托管, POP · QPS: 20 · updated 2026-08-21 20:02:11

通过该接口获取备货单的平台收货仓地址信息（适用全托管、SHEIN自营模式）；

**Query string**

- `addressId` int64 **req** — 从发货基本信息查询接口 (https://open.sheincorp.com/zh/documents/apidoc/detail/3000943)获取；
- `coding` string  — 车队编码
- `expressMode` string  — 快递编码
- `orderType` integer **req** — 订单类型；1:急采；2：备货
- `sendType` integer **req** — 发货方式；从发货基本信息查询接口 (https://open.sheincorp.com/zh/documents/apidoc/detail/3000943)获取；
- `orderNoList` string[]  — 采购单号；建议填写，会影响地址的准确性；最多入参200个；
- `shippingRoute` integer  — 发货路径，0：直送路径，无需装箱明细，1：直送路径，需要装箱明细，2：集货路径，从 发货基本信息查询接口 (https://open.sheincorp.com/documents/apidoc/detail/3001981) 查询

**Response body**

- `code` string **req** — 响应编码 成功：0
- `info` object  — 
  - `subWareHouseId` integer  — 子仓id
  - `subWarehouseName` string  — 子仓名称
  - `warehouseAddress` string  — 收货仓详细地址
  - `warehouseContact` string  — 仓联系人
  - `warehousePhone` string  — 样衣仓联系电话
  - `consolidationSubWareHouseId` integer  — 集货仓子仓id，仅发货路径为集货时有值
  - `consolidationSubWarehouseName` string  — 集货仓子仓名称，仅发货路径为集货时有值
  - `consolidationWarehouseAddress` string  — 集货仓收件详细地址，仅发货路径为集货时有值
  - `consolidationWarehouseCityArea` string  — 集货仓收件区，仅发货路径为集货时有值
  - `consolidationWarehouseCityName` string  — 集货仓收件城市，仅发货路径为集货时有值
  - `consolidationWarehouseContact` string  — 集货仓仓联系人，仅发货路径为集货时有值
  - `consolidationWarehousePhone` string  — 集货仓仓联系方式，仅发货路径为集货时有值
  - `consolidationWarehouseProvinceName` string  — 集货仓收件省（直辖市），仅发货路径为集货时有值
- `msg` string  — 错误描述,成功：OK；（全托管模式支持指定语种出参）；
- `traceId` string  — 请求的唯一标识；用于异常报错跟踪

**Request example**
```
curl --location --request GET 'https://openapi.sheincorp.cn/open-api/shipping/warehouse?addressId=4721&expressMode=shunfeng&orderType=1&sendType=1&orderNoList=1234566,234566,2345667' \
--header 'x-lt-signature: test' \
--header 'x-lt-openKeyId: test' \
--header 'Content-Type: application/json;charset=UTF-8' \
--header 'x-lt-timestamp: 1752570729613' \
--header 'language: EN' \
--data-raw ''
```

**Response example**
```
{
    "code": "0",
    "msg": "OK",
    "info": {
        "subWareHouseId": 4,
        "subWarehouseName": "佛山佳明仓",
        "warehouseAddress": "广东 深圳市 大鹏 12345",
        "warehouseContact": "佳明仓",
        "warehousePhone": "15222222222"
    },
    "bbl": null
}
```
