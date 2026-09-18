const express = require('express');
const pool = require('../../db');
const { authenticateToken, requirePermission } = require('../middleware/auth');

const router = express.Router();

// عرض جميع الإجراءات التصحيحية
router.get(
    '/',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    ca.corrective_action_id,
                    ca.nonconformity_no,
                    ca.work_order_id,
                    wo.work_order_no,
                    ca.quality_inspection_id,
                    qi.inspection_no,
                    ca.complaint_id,
                    ca.description,
                    ca.root_cause,
                    ca.containment_action,
                    ca.corrective_action,
                    ca.preventive_action,
                    ca.responsible_employee_id,
                    e.full_name AS responsible_employee_name,
                    ca.due_date,
                    ca.completed_at,
                    ca.effectiveness_check,
                    ca.status,
                    ca.created_at,
                    ca.updated_at
                FROM corrective_actions ca
                LEFT JOIN work_orders wo
                    ON wo.work_order_id = ca.work_order_id
                LEFT JOIN quality_inspections qi
                    ON qi.quality_inspection_id = ca.quality_inspection_id
                LEFT JOIN employees e
                    ON e.employee_id = ca.responsible_employee_id
                ORDER BY ca.created_at DESC
            `);

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('Get corrective actions error:', error);
            res.status(500).json({
                success: false,
                message: 'تعذر تحميل الإجراءات التصحيحية'
            });
        }
    }
);

// إنشاء إجراء تصحيحي
router.post(
    '/',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const {
                work_order_id,
                quality_inspection_id,
                complaint_id,
                description,
                root_cause,
                containment_action,
                corrective_action,
                preventive_action,
                responsible_employee_id,
                due_date,
                effectiveness_check,
                status
            } = req.body;

            if (!description) {
                return res.status(400).json({
                    success: false,
                    message: 'وصف عدم المطابقة مطلوب'
                });
            }

            const result = await pool.query(
                `
                INSERT INTO corrective_actions (
                    work_order_id,
                    quality_inspection_id,
                    complaint_id,
                    description,
                    root_cause,
                    containment_action,
                    corrective_action,
                    preventive_action,
                    responsible_employee_id,
                    due_date,
                    effectiveness_check,
                    status,
                    created_by
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, COALESCE($12, 'OPEN'), $13
                )
                RETURNING *
                `,
                [
                    work_order_id || null,
                    quality_inspection_id || null,
                    complaint_id || null,
                    description,
                    root_cause || null,
                    containment_action || null,
                    corrective_action || null,
                    preventive_action || null,
                    responsible_employee_id || null,
                    due_date || null,
                    effectiveness_check || null,
                    status || null,
                    req.user.user_id
                ]
            );

            res.status(201).json({
                success: true,
                message: 'تم إنشاء الإجراء التصحيحي بنجاح',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('Create corrective action error:', error);
            res.status(500).json({
                success: false,
                message: 'تعذر إنشاء الإجراء التصحيحي'
            });
        }
    }
);

// تحديث إجراء تصحيحي
router.patch(
    '/:id',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const { id } = req.params;

            const {
                description,
                root_cause,
                containment_action,
                corrective_action,
                preventive_action,
                responsible_employee_id,
                due_date,
                completed_at,
                effectiveness_check,
                status
            } = req.body;

            const result = await pool.query(
                `
                UPDATE corrective_actions
                SET
                    description = COALESCE($1, description),
                    root_cause = COALESCE($2, root_cause),
                    containment_action = COALESCE($3, containment_action),
                    corrective_action = COALESCE($4, corrective_action),
                    preventive_action = COALESCE($5, preventive_action),
                    responsible_employee_id = COALESCE($6, responsible_employee_id),
                    due_date = COALESCE($7, due_date),
                    completed_at = CASE
                        WHEN COALESCE($10, status) = 'COMPLETED'
                            THEN COALESCE($8, completed_at, CURRENT_TIMESTAMP)
                        ELSE completed_at
                    END,
                    effectiveness_check = COALESCE($9, effectiveness_check),
                    status = COALESCE($10, status)
                WHERE corrective_action_id = $11
                RETURNING *
                `,
                [
                    description,
                    root_cause,
                    containment_action,
                    corrective_action,
                    preventive_action,
                    responsible_employee_id || null,
                    due_date || null,
                    completed_at || null,
                    effectiveness_check,
                    status,
                    id
                ]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'الإجراء التصحيحي غير موجود'
                });
            }

            res.json({
                success: true,
                message: 'تم تحديث الإجراء التصحيحي بنجاح',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('Update corrective action error:', error);
            res.status(500).json({
                success: false,
                message: 'تعذر تحديث الإجراء التصحيحي'
            });
        }
    }
);

module.exports = router;
