-- 合同上传原件磁盘路径：导出 Word 修订稿时需要基于原始 docx 注入修订痕迹以保留原版式
ALTER TABLE "contracts" ADD COLUMN "storage_path" VARCHAR(300);