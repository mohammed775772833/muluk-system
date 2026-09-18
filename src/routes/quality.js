const express = require('express');
const pool = require('../../db');
const { authenticateToken, requirePermission } = require('../middleware/auth');

const router = express.Router();

// عرض جميع فحوصات الجودة
router.get(
    '/inspections',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    qi.quality_inspection_id,
                    qi.work_order_id,
                    wo.work_order_no,
                    qi.inspection_no,
                    qi.inspector_id,
                    e.full_name AS inspector_name,
                    qi.inspection_round,
                    qi.result,
                    qi.workmanship_result,
                    qi.material_result,
                    qi.appearance_result,
                    qi.function_result,
                    qi.customer_requirements_result,
                    qi.defects_found,
                    qi.notes,
                    qi.inspected_at
                FROM quality_inspections qi
                JOIN work_orders wo
                    ON wo.work_order_id = qi.work_order_id
                LEFT JOIN employees e
                    ON e.employee_id = qi.inspector_id
                ORDER BY qi.inspected_at DESC
            `);

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('Get quality inspections error:', error);
            res.status(500).json({
                success: false,
                message: 'تعذر تحميل فحوصات الجودة'
            });
        }
    }
);

// إنشاء فحص جودة جديد
router.post(
    '/inspections',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const {
                work_order_id,
                inspector_id,
                inspection_round,
                result,
                workmanship_result,
                material_result,
                appearance_result,
                function_result,
                customer_requirements_result,
                defects_found,
                notes
            } = req.body;

            if (!work_order_id || !inspector_id) {
                return res.status(400).json({
                    success: false,
                    message: 'رقم أمر العمل والفاحص مطلوبان'
                });
            }

            const resultQuery = await pool.query(
                `
                INSERT INTO quality_inspections (
                    work_order_id,
                    inspector_id,
                    inspection_round,
                    result,
                    workmanship_result,
                    material_result,
                    appearance_result,
                    function_result,
                    customer_requirements_result,
                    defects_found,
                    notes
                )
                VALUES (
                    $1,
                    $2,
                    COALESCE($3, 1),
                    COALESCE($4, 'PENDING')::inspection_result,
                    COALESCE($5, 'PENDING')::inspection_result,
                    COALESCE($6, 'PENDING')::inspection_result,
                    COALESCE($7, 'PENDING')::inspection_result,
                    COALESCE($8, 'PENDING')::inspection_result,
                    COALESCE($9, 'PENDING')::inspection_result,
                    $10,
                    $11
                )
                RETURNING *
                `,
                [
                    work_order_id,
                    inspector_id,
                    inspection_round,
                    result,
                    workmanship_result,
                    material_result,
                    appearance_result,
                    function_result,
                    customer_requirements_result,
                    defects_found || null,
                    notes || null
                ]
            );

            const createdInspection = resultQuery.rows[0];

            // إذا كانت نتيجة الفحص FAILED يتم إنشاء إجراء تصحيحي تلقائيًا
            if (createdInspection.result === 'FAILED') {
                const existingCorrective = await pool.query(
                    `SELECT corrective_action_id
                     FROM corrective_actions
                     WHERE quality_inspection_id = $1
                     LIMIT 1`,
                    [createdInspection.quality_inspection_id]
                );

                if (existingCorrective.rowCount === 0) {
                    await pool.query(
                        `INSERT INTO corrective_actions (
                            work_order_id,
                            quality_inspection_id,
                            description,
                            root_cause,
                            corrective_action,
                            responsible_employee_id,
                            status,
                            created_by
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7)`,
                        [
                            createdInspection.work_order_id,
                            createdInspection.quality_inspection_id,
                            createdInspection.defects_found || 'تم تسجيل عدم مطابقة في فحص الجودة',
                            null,
                            null,
                            createdInspection.inspector_id,
                            req.user.user_id
                        ]
                    );
                }
            }

            res.status(201).json({
                success: true,
                message: 'تم إنشاء فحص الجودة بنجاح',
                data: createdInspection
            });
        } catch (error) {
            console.error('Create quality inspection error:', error);
            res.status(500).json({
                success: false,
                message: 'تعذر إنشاء فحص الجودة'
            });
        }
    }
);

// تحديث فحص جودة
router.patch(
    '/inspections/:id',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const { id } = req.params;

            const {
                result,
                workmanship_result,
                material_result,
                appearance_result,
                function_result,
                customer_requirements_result,
                defects_found,
                notes
            } = req.body;

            const resultQuery = await pool.query(
                `
                UPDATE quality_inspections
                SET
                    result = COALESCE($1, result),
                    workmanship_result = COALESCE($2, workmanship_result),
                    material_result = COALESCE($3, material_result),
                    appearance_result = COALESCE($4, appearance_result),
                    function_result = COALESCE($5, function_result),
                    customer_requirements_result = COALESCE($6, customer_requirements_result),
                    defects_found = $7,
                    notes = $8
                WHERE quality_inspection_id = $9
                RETURNING *
                `,
                [
                    result,
                    workmanship_result,
                    material_result,
                    appearance_result,
                    function_result,
                    customer_requirements_result,
                    defects_found || null,
                    notes || null,
                    id
                ]
            );

            if (resultQuery.rowCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'فحص الجودة غير موجود'
                });
            }

            res.json({
                success: true,
                message: 'تم تحديث فحص الجودة بنجاح',
                data: resultQuery.rows[0]
            });
        } catch (error) {
            console.error('Update quality inspection error:', error);
            res.status(500).json({
                success: false,
                message: 'تعذر تحديث فحص الجودة'
            });
        }
    }
);

module.exports = router;
