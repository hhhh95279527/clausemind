-- 合同类型来源：USER=用户手选 / AUTO=待 AI 识别 / AI=AI 自动识别（存量 NULL 视为 USER）
-- contracts.scene 仍是 DB enum（不支持 'AUTO' 占位），识别态用本列表达
ALTER TABLE "contracts" ADD COLUMN "scene_source" VARCHAR(10);
